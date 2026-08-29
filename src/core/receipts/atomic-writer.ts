import {mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export type AtomicFileOperations = Readonly<{
	mkdir: (directory: string) => Promise<void>;
	openExclusive: (filePath: string) => Promise<FileHandle>;
	readExisting: (filePath: string) => Promise<Uint8Array | undefined>;
	rename: (source: string, destination: string) => Promise<void>;
	remove: (filePath: string) => Promise<void>;
}>;

const defaultOperations: AtomicFileOperations = {
	mkdir: async directory => {
		await mkdir(directory, {recursive: true});
	},
	openExclusive: async filePath => open(filePath, 'wx', 0o600),
	readExisting: async filePath => {
		try {
			return await readFile(filePath);
		} catch (error: unknown) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
				return undefined;
			}
			throw error;
		}
	},
	rename,
	remove: async filePath => {
		await rm(filePath, {force: true});
	},
};

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength
		&& left.every((value, index) => value === right[index]);
}

export class AtomicFileWriter {
	constructor(private readonly operations: AtomicFileOperations = defaultOperations) {}

	async write(destinationInput: string, content: Uint8Array): Promise<void> {
		const destination = path.resolve(destinationInput);
		await this.operations.mkdir(path.dirname(destination));
		const existing = await this.operations.readExisting(destination);
		if (existing !== undefined) {
			if (equalBytes(existing, content)) {
				return;
			}
			throw new Error(`Refusing to overwrite non-identical receipt file: ${destination}`);
		}

		const temporaryPath = path.join(
			path.dirname(destination),
			`.antibody-${path.basename(destination)}-${randomUUID()}.tmp`,
		);
		let handle: FileHandle | undefined;
		try {
			handle = await this.operations.openExclusive(temporaryPath);
			await handle.writeFile(content);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.operations.rename(temporaryPath, destination);
		} finally {
			if (handle !== undefined) {
				await handle.close();
			}
			await this.operations.remove(temporaryPath);
		}
	}
}
