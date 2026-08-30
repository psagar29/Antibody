import {describe, expect, it} from 'vitest';

import {inferTargetTestNames} from '../../src/core/recover.js';

describe('inferTargetTestNames', () => {
  it('extracts common JavaScript, Python, Go, Ruby, and JUnit names from additions only', () => {
    const patch = [
      'diff --git a/test/example b/test/example',
      '--- a/test/example',
      '+++ b/test/example',
      '@@ -1 +1,8 @@',
      "-test('old behavior', () => {})",
      "+test('keeps spaces', () => {})",
      '+it.concurrent(`handles tabs`, () => {})',
      '+def test_unicode_slug():',
      '+func TestEmptyValue(t *testing.T) {',
      "+it 'rejects bad bytes' do",
      '+@Test',
      '+public void preservesOrder() {',
    ].join('\n');

    expect(inferTargetTestNames(patch)).toEqual([
      'keeps spaces',
      'handles tabs',
      'test_unicode_slug',
      'TestEmptyValue',
      'rejects bad bytes',
      'preservesOrder',
    ]);
  });

  it('rejects anonymous and interpolated tests', () => {
    expect(inferTargetTestNames('+test();\n+test(`case ${value}`, () => {})')).toEqual([]);
  });
});
