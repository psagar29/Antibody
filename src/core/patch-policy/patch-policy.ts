import path from 'node:path';

import {z} from 'zod';

import {
	ConfigSchema,
	FullGitShaSchema,
	type FullGitSha,
	type RepoPath,
	type Sha256,
} from '../../contracts/index.js';
import {checkPatchAgainstTrees, type ApplyCheckLane} from '../../adapters/git/apply-checker.js';
import {sha256Text} from '../digest.js';
import {matchesAnyGlob} from '../globs.js';
import {parseUnifiedDiff, type UnifiedDiff} from './unified-diff.js';

const PatchPolicyRequestSchema = z
	.object({
		repositoryRoot: z.string().min(1).max(32_768),
		patch: z.string().max(10_485_760),
		commits: z
			.object({
				parent: FullGitShaSchema,
				fix: FullGitShaSchema,
				head: FullGitShaSchema,
			})
			.strict(),
		testGlobs: ConfigSchema.shape.scan.shape.testGlobs,
		allowedSupportGlobs: ConfigSchema.shape.scan.shape.allowedSupportGlobs,
		policy: ConfigSchema.shape.policy,
	})
	.strict();

export type PatchPolicyRejectionCode =
	| 'empty-patch'
	| 'invalid-unified-diff'
	| 'patch-too-large'
	| 'too-many-files'
	| 'too-many-added-lines'
	| 'disallowed-path'
	| 'workflow-path'
	| 'rename-or-copy'
	| 'binary-patch'
	| 'special-file-mode'
	| 'executable-mode'
	| 'deleted-test'
	| 'no-executable-test'
	| `git-apply-${ApplyCheckLane}`;

export type PatchPolicyResult =
	| Readonly<{
		accepted: true;
		patchSha256: Sha256;
		changedPaths: readonly RepoPath[];
		parsed: UnifiedDiff;
	}>
	| Readonly<{
		accepted: false;
		reasons: readonly PatchPolicyRejectionCode[];
	}>;

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function pathsFromPatch(parsed: UnifiedDiff): RepoPath[] {
	return unique(parsed.files.flatMap(file => [file.oldPath, file.newPath]
		.filter((repositoryPath): repositoryPath is RepoPath => repositoryPath !== null)));
}

function isSpecialMode(mode: string): boolean {
	return mode === '120000' || mode === '160000';
}

function isExecutableMode(mode: string): boolean {
	return mode.endsWith('755');
}

function isAlwaysDisallowedPath(repositoryPath: string): boolean {
	const basename = path.posix.basename(repositoryPath);
	return /(^|\/)(?:dist|build|coverage|generated|node_modules|vendor)(?:\/|$)/u.test(
		repositoryPath,
	)
		|| repositoryPath.startsWith('.github/')
		|| /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/u.test(
			basename,
		)
		|| /(?:^|\.)config\.(?:js|cjs|mjs|ts|json|yaml|yml)$/u.test(basename);
}

export class TestOnlyPatchPolicy {
	async evaluate(input: z.input<typeof PatchPolicyRequestSchema>): Promise<PatchPolicyResult> {
		const request = PatchPolicyRequestSchema.parse(input);
		const patchBytes = Buffer.byteLength(request.patch, 'utf8');
		if (request.patch.trim().length === 0) {
			return {accepted: false, reasons: ['empty-patch']};
		}

		if (patchBytes > request.policy.maxPatchBytes) {
			return {accepted: false, reasons: ['patch-too-large']};
		}

		let parsed: UnifiedDiff;
		try {
			parsed = parseUnifiedDiff(request.patch);
		} catch {
			return {accepted: false, reasons: ['invalid-unified-diff']};
		}

		const reasons: PatchPolicyRejectionCode[] = [];
		const changedPaths = pathsFromPatch(parsed);
		const allowedPatterns = [...request.testGlobs, ...request.allowedSupportGlobs];
		if (parsed.files.length > request.policy.maxPatchFiles) {
			reasons.push('too-many-files');
		}

		if (parsed.addedLines > request.policy.maxAddedLines) {
			reasons.push('too-many-added-lines');
		}

		if (changedPaths.some(repositoryPath =>
			!matchesAnyGlob(repositoryPath, allowedPatterns)
			|| isAlwaysDisallowedPath(repositoryPath))) {
			reasons.push('disallowed-path');
		}

		if (changedPaths.some(repositoryPath => repositoryPath.startsWith('.github/workflows/'))) {
			reasons.push('workflow-path');
		}

		if (parsed.files.some(file => file.isRenameOrCopy)) {
			reasons.push('rename-or-copy');
		}

		if (parsed.files.some(file => file.isBinary)) {
			reasons.push('binary-patch');
		}

		if (parsed.files.some(file => file.modes.some(isSpecialMode))) {
			reasons.push('special-file-mode');
		}

		if (parsed.files.some(file => file.modes.some(isExecutableMode))) {
			reasons.push('executable-mode');
		}

		if (parsed.files.some(file => file.isDeleted)) {
			reasons.push('deleted-test');
		}

		if (!parsed.files.some(file => {
			const repositoryPath = file.newPath ?? file.oldPath;
			return repositoryPath !== null
				&& matchesAnyGlob(repositoryPath, request.testGlobs)
				&& file.addedExecutableTestLines > 0;
		})) {
			reasons.push('no-executable-test');
		}

		if (reasons.length > 0) {
			return {accepted: false, reasons: unique(reasons)};
		}

		const applyResults = await checkPatchAgainstTrees(
			path.resolve(request.repositoryRoot),
			parsed.text,
			request.commits satisfies Readonly<Record<ApplyCheckLane, FullGitSha>>,
		);
		for (const result of applyResults) {
			if (!result.applies) {
				reasons.push(`git-apply-${result.lane}`);
			}
		}

		if (reasons.length > 0) {
			return {accepted: false, reasons: unique(reasons)};
		}

		return {
			accepted: true,
			patchSha256: sha256Text(parsed.text),
			changedPaths,
			parsed,
		};
	}
}
