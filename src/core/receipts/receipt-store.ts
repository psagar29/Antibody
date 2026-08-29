import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {canonicalize} from 'json-canonicalize';
import {z} from 'zod';

import {
	ClassifiedAttemptSchema,
	RawVerificationEvidenceSchema,
	ReceiptSchema,
	RecoveryCandidateSchema,
	Sha256Schema,
} from '../../contracts/index.js';
import {sha256Bytes, sha256Canonical} from '../digest.js';
import {AtomicFileWriter} from './atomic-writer.js';
import type {BuiltReceiptBundle} from './receipt-builder.js';

function canonicalBytes(value: unknown): Uint8Array {
	return Buffer.from(canonicalize(value), 'utf8');
}

function artifactFileName(
	lane: string,
	phase: string,
	attempt: number,
	kind: 'stdout' | 'stderr' | 'report',
): string {
	return `${lane}-${phase}-${String(attempt)}.${kind}`;
}

function decodeContent(value: string): Uint8Array {
	const bytes = Buffer.from(value, 'base64');
	if (bytes.toString('base64') !== value) {
		throw new Error('Artifact content is not canonical base64');
	}
	return bytes;
}

export async function persistReceiptBundle(
	repositoryRoot: string,
	bundle: BuiltReceiptBundle,
	patch: string,
	writer = new AtomicFileWriter(),
): Promise<string> {
	const receipt = ReceiptSchema.parse(bundle.receipt);
	const rawEvidence = RawVerificationEvidenceSchema.parse(bundle.rawEvidence);
	if (sha256Canonical(receipt) !== bundle.receiptSha256) {
		throw new Error('Receipt bundle digest is inconsistent');
	}
	if (sha256Bytes(Buffer.from(patch, 'utf8')) !== receipt.patch.sha256) {
		throw new Error('Receipt bundle patch digest is inconsistent');
	}

	const runDirectory = path.join(
		path.resolve(repositoryRoot),
		'.antibody',
		'runs',
		receipt.runId,
	);
	await writer.write(path.join(runDirectory, 'candidate.json'), canonicalBytes(receipt.candidate));
	await writer.write(path.join(runDirectory, 'patch.diff'), Buffer.from(patch, 'utf8'));
	await writer.write(path.join(runDirectory, 'raw-evidence.json'), canonicalBytes(rawEvidence));
	await writer.write(
		path.join(runDirectory, 'classified-evidence.json'),
		canonicalBytes(receipt.classifications),
	);
	for (const attempt of rawEvidence.attempts) {
		const artifacts = [
			{kind: 'stdout' as const, artifact: attempt.stdout},
			{kind: 'stderr' as const, artifact: attempt.stderr},
			...(attempt.report === undefined
				? []
				: [{kind: 'report' as const, artifact: attempt.report}]),
		];
		for (const entry of artifacts) {
			if (entry.artifact.contentBase64 !== undefined) {
				await writer.write(
					path.join(
						runDirectory,
						'artifacts',
						artifactFileName(attempt.lane, attempt.phase, attempt.attempt, entry.kind),
					),
					decodeContent(entry.artifact.contentBase64),
				);
			}
		}
	}
	await writer.write(path.join(runDirectory, 'receipt.json'), canonicalBytes(receipt));
	await writer.write(
		path.join(runDirectory, 'receipt.sha256'),
		Buffer.from(`${bundle.receiptSha256}\n`, 'utf8'),
	);
	return runDirectory;
}

export type ReceiptVerification = Readonly<{
	valid: boolean;
	reasons: readonly string[];
}>;

export async function verifyPersistedRun(runDirectoryInput: string): Promise<ReceiptVerification> {
	const runDirectory = path.resolve(runDirectoryInput);
	const reasons: string[] = [];
	let receiptText: string;
	let rawText: string;
	let candidateText: string;
	let classificationsText: string;
	let patchBytes: Uint8Array;
	let recordedDigest: string;
	try {
		[
			receiptText,
			rawText,
			candidateText,
			classificationsText,
			patchBytes,
			recordedDigest,
		] = await Promise.all([
			readFile(path.join(runDirectory, 'receipt.json'), 'utf8'),
			readFile(path.join(runDirectory, 'raw-evidence.json'), 'utf8'),
			readFile(path.join(runDirectory, 'candidate.json'), 'utf8'),
			readFile(path.join(runDirectory, 'classified-evidence.json'), 'utf8'),
			readFile(path.join(runDirectory, 'patch.diff')),
			readFile(path.join(runDirectory, 'receipt.sha256'), 'utf8'),
		]);
	} catch {
		return {valid: false, reasons: ['missing-or-unreadable-bundle-file']};
	}

	try {
		const receipt = ReceiptSchema.parse(JSON.parse(receiptText));
		const raw = RawVerificationEvidenceSchema.parse(JSON.parse(rawText));
		const candidate = RecoveryCandidateSchema.parse(JSON.parse(candidateText));
		const classifications = z.array(ClassifiedAttemptSchema).parse(JSON.parse(classificationsText));
		const digest = Sha256Schema.parse(recordedDigest.trim());
		if (receiptText !== canonicalize(receipt)) reasons.push('receipt-not-canonical');
		if (rawText !== canonicalize(raw)) reasons.push('raw-evidence-not-canonical');
		if (candidateText !== canonicalize(candidate)) reasons.push('candidate-not-canonical');
		if (classificationsText !== canonicalize(classifications)) reasons.push('classifications-not-canonical');
		if (sha256Canonical(receipt) !== digest) reasons.push('receipt-digest-mismatch');
		if (sha256Canonical(raw) !== receipt.evidence.rawEvidenceSha256) reasons.push('raw-evidence-digest-mismatch');
		if (sha256Canonical(candidate) !== sha256Canonical(receipt.candidate)) reasons.push('candidate-mismatch');
		if (sha256Canonical(classifications) !== sha256Canonical(receipt.classifications)) reasons.push('classifications-mismatch');
		if (sha256Bytes(patchBytes) !== receipt.patch.sha256
			|| patchBytes.byteLength !== receipt.patch.sizeBytes) reasons.push('patch-digest-mismatch');
		const rawManifests = raw.attempts.flatMap(attempt => [
			attempt.stdout,
			attempt.stderr,
			...(attempt.report === undefined ? [] : [attempt.report]),
		]).map(artifact => ({
			name: artifact.name,
			mediaType: artifact.mediaType,
			sha256: artifact.sha256,
			sizeBytes: artifact.sizeBytes,
		}));
		if (sha256Canonical(rawManifests) !== sha256Canonical(receipt.evidence.artifacts)) {
			reasons.push('artifact-manifest-mismatch');
		}
		for (const attempt of raw.attempts) {
			const artifacts = [
				{kind: 'stdout' as const, artifact: attempt.stdout},
				{kind: 'stderr' as const, artifact: attempt.stderr},
				...(attempt.report === undefined
					? []
					: [{kind: 'report' as const, artifact: attempt.report}]),
			];
			for (const entry of artifacts) {
				if (entry.artifact.contentBase64 === undefined) {
					continue;
				}
				try {
					const stored = await readFile(path.join(
						runDirectory,
						'artifacts',
						artifactFileName(attempt.lane, attempt.phase, attempt.attempt, entry.kind),
					));
					if (sha256Bytes(stored) !== entry.artifact.sha256
						|| stored.byteLength !== entry.artifact.sizeBytes) {
						reasons.push('artifact-digest-mismatch');
					}
				} catch {
					reasons.push('artifact-missing-or-unreadable');
				}
			}
		}
	} catch {
		reasons.push('schema-or-canonicalization-failure');
	}

	return {valid: reasons.length === 0, reasons};
}
