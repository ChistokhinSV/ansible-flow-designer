import { describe, expect, it } from 'vitest';
import { moduleDocsUrl } from '../../../src/core/catalog/docsLink';

describe('moduleDocsUrl (AFD-312)', () => {
  it('keeps docs.ansible.com for ansible.builtin', () => {
    expect(moduleDocsUrl('ansible.builtin.copy')).toBe(
      'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/copy_module.html',
    );
  });

  it('links any other collection to its Galaxy module page', () => {
    expect(moduleDocsUrl('chistokhinsv.ansible_flow.run')).toBe(
      'https://galaxy.ansible.com/ui/repo/published/chistokhinsv/ansible_flow/content/module/run/',
    );
    expect(moduleDocsUrl('cisco.ios.ios_config')).toBe(
      'https://galaxy.ansible.com/ui/repo/published/cisco/ios/content/module/ios_config/',
    );
  });

  it('gives none for a short name or one that is not a plain FQCN', () => {
    expect(moduleDocsUrl('copy')).toBeUndefined();
    expect(moduleDocsUrl('a.b.c.d')).toBeUndefined();
    expect(moduleDocsUrl('a.b/../x.c')).toBeUndefined();
  });
});
