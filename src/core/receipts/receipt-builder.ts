import {z} from 'zod';

import {
	ArtifactSchema,
	ClassifiedAttemptSchema,
	RawVerificationEvidenceSchema,
	ReceiptSchema,
	RecoveryCandidateSchema,
	RepoPathSchema,
	VerdictSchema,
	type ArtifactV1,
	type RawVerificationEvidenceV1,
	type ReceiptV1,
	type Sha256,
} from '../../contracts/index.js';
import {sha256Bytes, sha256Canonical} from '../digest.js';

const BuildReceiptInputSchema = z
	.object({
		candidate: RecoveryCandidateSchema,
		patch: z.string().min(1).max(10_485_760),
		changedPaths: z.array(RepoPathSchema).min(1).max(1000),
		policy: ReceiptSchema.shape.policy,
		rawEvidence: RawVerificationEvidenceSchema,
		classifications: z.array(ClassifiedAttemptSchema),
		environment: z
			.object({
				source: ReceiptSchema.shape.environment.shape.source,
				networkPolicyId: z.string().min(1).max(512).optional(),
			})
			.strict(),
		verdict: VerdictSchema,
		reasonCodes: z.array(z.string().min(1).max(128)),
		createdAt: z.iso.datetime(),
		modelUsd: z.number().nonnegative().optional(),
		redactionSecrets: z.array(z.string().min(1).max(16_384)).max(128),
	})
	.strict();

export type BuiltReceiptBundle = Readonly<{
	receipt: ReceiptV1;
	receiptSha256: Sha256;
	rawEvidence: RawVerificationEvidenceV1;
}>;

const tokenPatterns = [
	/\bghp_[A-Za-z0-9]{20,}\b/gu,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
	/\bsk-[A-Za-z0-9_-]{20,}\b/gu,
	/\bAKIA[0-9A-Z]{16}\b/gu,
	/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/giu,
];

export function redactSensitiveText(value: string, secrets: readonly string[]): string {
	let redacted = value;
	for (const secret of secrets.filter(item => item.length >= 4)) {
		redacted = redacted.replaceAll(secret, '[REDACTED]');
	}
	for (const pattern of tokenPatterns) {
		redacted = redacted.replaceAll(pattern, '[REDACTED]');
	}
	return redacted;
}

function decodeArtifactContent(artifact: ArtifactV1): Uint8Array | undefined {
	if (artifact.contentBase64 === undefined) {
		return undefined;
	}
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(artifact.contentBase64)) {
		throw new Error(`Artifact ${artifact.name} has non-canonical base64`);
	}

	const bytes = Buffer.from(artifact.contentBase64, 'base64');
	if (bytes.toString('base64') !== artifact.contentBase64
		|| bytes.byteLength !== artifact.sizeBytes
		|| sha256Bytes(bytes) !== artifact.sha256) {
		throw new Error(`Artifact ${artifact.name} content does not match its manifest`);
	}
	return bytes;
}

function redactArtifact(artifactInput: ArtifactV1, secrets: readonly string[]): ArtifactV1 {
	const artifact = ArtifactSchema.parse(artifactInput);
	const bytes = decodeArtifactContent(artifact);
	if (bytes === undefined) {
		return artifact;
	}

	let text: string;
	try {
		text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
	} catch {
		throw new Error(`Artifact ${artifact.name} must be valid UTF-8 before persistence`);
	}
	const redactedBytes = Buffer.from(redactSensitiveText(text, secrets), 'utf8');
	return ArtifactSchema.parse({
		...artifact,
		sha256: sha256Bytes(redactedBytes),
		sizeBytes: redactedBytes.byteLength,
		contentBase64: redactedBytes.toString('base64'),
	});
}

export function redactRawEvidence(
	rawInput: RawVerificationEvidenceV1,
	secrets: readonly string[],
): RawVerificationEvidenceV1 {
	const raw = RawVerificationEvidenceSchema.parse(rawInput);
	return RawVerificationEvidenceSchema.parse({
		...raw,
		attempts: raw.attempts.map(attempt => ({
			...attempt,
			stdout: redactArtifact(attempt.stdout, secrets),
			stderr: redactArtifact(attempt.stderr, secrets),
			...(attempt.report === undefined
				? {}
				: {report: redactArtifact(attempt.report, secrets)}),
		})),
	});
}

function manifest(artifact: ArtifactV1): Omit<ArtifactV1, 'contentBase64'> {
	return {
		name: artifact.name,
		mediaType: artifact.mediaType,
		sha256: artifact.sha256,
		sizeBytes: artifact.sizeBytes,
	};
}

function evidenceArtifacts(raw: RawVerificationEvidenceV1): Omit<ArtifactV1, 'contentBase64'>[] {
	return raw.attempts.flatMap(attempt => [
		manifest(attempt.stdout),
		manifest(attempt.stderr),
		...(attempt.report === undefined ? [] : [manifest(attempt.report)]),
	]);
}

export function buildReceipt(
	input: z.input<typeof BuildReceiptInputSchema>,
): BuiltReceiptBundle {
	const parsed = BuildReceiptInputSchema.parse(input);
	const patchBytes = Buffer.from(parsed.patch, 'utf8');
	const patchSha256 = sha256Bytes(patchBytes);
	if (parsed.rawEvidence.candidateId !== parsed.candidate.candidateId) {
		throw new Error('Raw evidence candidateId does not match the receipt candidate');
	}
	if (parsed.rawEvidence.patchSha256 !== patchSha256) {
		throw new Error('Raw evidence patch digest does not match the receipt patch');
	}

	const rawEvidence = redactRawEvidence(parsed.rawEvidence, parsed.redactionSecrets);
	const patchArtifact = {
		name: 'patch.diff',
		mediaType: 'text/x-diff; charset=utf-8',
		sha256: patchSha256,
		sizeBytes: patchBytes.byteLength,
	};
	const receipt = ReceiptSchema.parse({
		schemaVersion: 'antibody.receipt/v1',
		runId: rawEvidence.runId,
		candidate: parsed.candidate,
		patch: {
			sha256: patchSha256,
			sizeBytes: patchBytes.byteLength,
			changedPaths: parsed.changedPaths,
			artifact: patchArtifact,
		},
		policy: parsed.policy,
		environment: {
			...rawEvidence.environmentEquivalence,
			source: parsed.environment.source,
			...(parsed.environment.networkPolicyId === undefined
				? {}
				: {networkPolicyId: parsed.environment.networkPolicyId}),
		},
		classifications: parsed.classifications,
		evidence: {
			rawEvidenceSha256: sha256Canonical(rawEvidence),
			artifacts: evidenceArtifacts(rawEvidence),
			...(rawEvidence.reflex === undefined ? {} : {reflex: rawEvidence.reflex}),
			cleanup: rawEvidence.cleanup,
		},
		costs: {
			...(parsed.modelUsd === undefined ? {} : {modelUsd: parsed.modelUsd}),
			...(rawEvidence.runloopCostUsd === undefined
				? {}
				: {runloopUsd: rawEvidence.runloopCostUsd}),
		},
		verdict: parsed.verdict,
		reasonCodes: parsed.reasonCodes,
		createdAt: parsed.createdAt,
	});
	return {receipt, receiptSha256: sha256Canonical(receipt), rawEvidence};
}
