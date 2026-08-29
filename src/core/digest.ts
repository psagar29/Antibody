import {createHash} from 'node:crypto';

import {canonicalize} from 'json-canonicalize';

import {Sha256Schema, type Sha256} from '../contracts/index.js';

export function normalizeLf(value: string): string {
	return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export function sha256Bytes(value: Uint8Array): Sha256 {
	return Sha256Schema.parse(
		`sha256:${createHash('sha256').update(value).digest('hex')}`,
	);
}

export function sha256Text(value: string): Sha256 {
	return sha256Bytes(Buffer.from(value, 'utf8'));
}

export function sha256Canonical(value: unknown): Sha256 {
	return sha256Text(canonicalize(value));
}
