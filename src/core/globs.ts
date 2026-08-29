const REGEXP_META = /[\\^$.[\]{}()+|]/u;

function escapeRegExpCharacter(character: string): string {
	return REGEXP_META.test(character) ? `\\${character}` : character;
}

export function globToRegExp(pattern: string): RegExp {
	let expression = '^';
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === undefined) {
			break;
		}

		if (character === '*') {
			const next = pattern[index + 1];
			if (next === '*') {
				index += 1;
				if (pattern[index + 1] === '/') {
					index += 1;
					expression += '(?:.*/)?';
				} else {
					expression += '.*';
				}
			} else {
				expression += '[^/]*';
			}

			continue;
		}

		if (character === '?') {
			expression += '[^/]';
			continue;
		}

		expression += escapeRegExpCharacter(character);
	}

	return new RegExp(`${expression}$`, 'u');
}

export function matchesAnyGlob(repositoryPath: string, patterns: readonly string[]): boolean {
	return patterns.some(pattern => globToRegExp(pattern).test(repositoryPath));
}
