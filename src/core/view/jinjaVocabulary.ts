// What the Jinja completion list offers besides a node's own variables (AFD-225): Ansible's and
// Jinja's globals, magic variables, filters, tests and lookups, the members of common values (a
// datetime, a string), and strftime's codes. The one-line docs are ours. The catalog adds the
// filters, tests and lookups of installed collections, with their own short descriptions; it never
// lists Jinja's built-ins, so this list is the main source for them.

export type ValueType =
  | 'datetime'
  | 'date'
  | 'time'
  | 'timedelta'
  | 'str'
  | 'list'
  | 'dict'
  | 'int'
  | 'bool'
  | 'loop';

export interface Word {
  name: string;
  /** What is inserted, when not the name: `now()`, `default('')`. */
  insert?: string;
  /** Where the caret goes inside `insert` (else after it). */
  caret?: number;
  /** The signature the help shows: `now(utc=False, fmt=None)`. */
  sig?: string;
  doc: string;
  /** What it gives: the members offered after a `.`. */
  returns?: ValueType;
  /** The list opens again after it is inserted (`strftime('')` → the format codes). */
  again?: boolean;
}

/** A word with a snippet: `name(args)`, the caret between the quotes when `args` has `''`. */
function call(name: string, args: string, doc: string, extra: Partial<Word> = {}): Word {
  const insert = `${name}(${args})`;
  const quotes = args.indexOf("''");
  return {
    name,
    insert,
    ...(quotes >= 0
      ? { caret: name.length + 1 + quotes + 1, again: true }
      : args
        ? { caret: name.length + 1 }
        : {}),
    doc,
    ...extra,
  };
}

/** Functions any expression can call. */
export const GLOBALS: Word[] = [
  {
    name: 'now',
    insert: 'now()',
    sig: 'now(utc=False, fmt=None)',
    doc: 'The current date and time on the controller, as a datetime.',
    returns: 'datetime',
  },
  {
    name: 'now',
    insert: 'now(utc=true)',
    sig: 'now(utc=False, fmt=None)',
    doc: 'The current date and time in UTC, as a datetime.',
    returns: 'datetime',
  },
  {
    name: 'now',
    insert: "now(fmt='')",
    caret: 9,
    again: true,
    sig: 'now(utc=False, fmt=None)',
    doc: 'The current date and time as text, formatted with strftime codes.',
    returns: 'str',
  },
  call('lookup', "''", 'Runs a lookup plugin on the controller; the results joined as text.', {
    sig: 'lookup(name, *terms, wantlist=False, **options)',
  }),
  call('query', "''", 'Runs a lookup plugin on the controller; the results as a list.', {
    sig: 'query(name, *terms, **options)',
    returns: 'list',
  }),
  call('q', "''", 'Short for query: a lookup whose results are a list.', {
    sig: 'q(name, *terms, **options)',
    returns: 'list',
  }),
  call('range', '', 'A sequence of whole numbers.', {
    sig: 'range([start,] stop[, step])',
    returns: 'list',
  }),
  call('dict', '', 'A dictionary made from keyword arguments.', {
    sig: 'dict(**items)',
    returns: 'dict',
  }),
  call('namespace', '', 'An object a loop can change: {% set ns.total = ns.total + 1 %}.', {
    sig: 'namespace(**attributes)',
  }),
  call('lipsum', '', 'Placeholder text.', { sig: 'lipsum(n=5, html=True, min=20, max=100)' }),
  call('cycler', '', 'Cycles through its values with .next().', { sig: 'cycler(*items)' }),
  call('joiner', "', '", 'Gives the separator from its second call on.', {
    sig: "joiner(sep=', ')",
  }),
  call('undef', '', 'An undefined value with a hint, for a default that must be set.', {
    sig: 'undef(hint=None)',
  }),
];

/** Variables Ansible and the generated plays set for every task. */
export const MAGIC: Word[] = [
  { name: 'inventory_hostname', doc: "The host's name in the inventory.", returns: 'str' },
  {
    name: 'inventory_hostname_short',
    doc: "The host's inventory name up to the first dot.",
    returns: 'str',
  },
  { name: 'hostvars', doc: "Every host's variables, by host name.", returns: 'dict' },
  { name: 'groups', doc: "Every group's hosts, by group name.", returns: 'dict' },
  { name: 'group_names', doc: 'The groups this host is in.', returns: 'list' },
  { name: 'ansible_facts', doc: 'The facts gathered from this host.', returns: 'dict' },
  { name: 'ansible_host', doc: 'The address Ansible connects to.', returns: 'str' },
  { name: 'ansible_play_hosts', doc: 'The play hosts that have not failed.', returns: 'list' },
  { name: 'ansible_play_hosts_all', doc: 'Every host the play started with.', returns: 'list' },
  { name: 'ansible_play_batch', doc: 'The hosts of the current batch (serial).', returns: 'list' },
  { name: 'ansible_check_mode', doc: 'Whether the run is in check mode.', returns: 'bool' },
  { name: 'ansible_diff_mode', doc: 'Whether the run shows diffs.', returns: 'bool' },
  {
    name: 'ansible_version',
    doc: "Ansible's version: full, major, minor, revision.",
    returns: 'dict',
  },
  { name: 'ansible_run_tags', doc: 'The tags the run was asked for.', returns: 'list' },
  { name: 'ansible_skip_tags', doc: 'The tags the run skips.', returns: 'list' },
  { name: 'ansible_limit', doc: 'The --limit of the run.', returns: 'str' },
  { name: 'inventory_dir', doc: "The folder of the host's inventory source.", returns: 'str' },
  { name: 'inventory_file', doc: "The host's inventory source.", returns: 'str' },
  { name: 'role_path', doc: "The running role's folder.", returns: 'str' },
  { name: 'role_name', doc: "The running role's name.", returns: 'str' },
  { name: 'omit', doc: 'As a parameter value: leaves the parameter out.' },
  { name: 'item', doc: "The loop's current item." },
  {
    name: 'ansible_loop',
    doc: 'Loop details (index, first, last…) with loop_control.extended.',
    returns: 'loop',
  },
  {
    name: 'afd_repo_root',
    doc: "The repository's root: generated plays run from generated/, so paths start here.",
    returns: 'str',
  },
  {
    name: 'afd_failed_result',
    doc: 'On a failure path: the result of the step that failed.',
    returns: 'dict',
  },
  { name: 'afd_failed_task', doc: 'On a failure path: the task that failed.', returns: 'str' },
  {
    name: 'afd_failed_node',
    doc: 'On a failure path: the key of the step that failed.',
    returns: 'str',
  },
];

export const CONSTANTS: Word[] = [
  { name: 'true', doc: 'True.', returns: 'bool' },
  { name: 'false', doc: 'False.', returns: 'bool' },
  { name: 'none', doc: 'No value (Python None).' },
];

/** Words between operands. */
export const OPERATORS: Word[] = [
  { name: 'and', doc: 'Both sides are true.' },
  { name: 'or', doc: 'Either side is true.' },
  { name: 'not', doc: 'The opposite.' },
  { name: 'in', doc: 'Contained in a list, string or dict.' },
  { name: 'is', insert: 'is ', doc: 'Applies a test: x is defined.', again: true },
  { name: 'if', doc: 'A value if a condition holds: a if c else b.' },
  { name: 'else', doc: 'The value when the condition does not hold.' },
];

/** The first word of a `{% %}` statement. */
export const STATEMENTS: Word[] = [
  { name: 'if', doc: 'Renders what follows when a condition holds.' },
  { name: 'elif', doc: 'Another condition.' },
  { name: 'else', doc: 'When no condition held.' },
  { name: 'endif', doc: 'Ends an if.' },
  { name: 'for', insert: 'for  in ', caret: 4, doc: 'Renders what follows for each item.' },
  { name: 'endfor', doc: 'Ends a for.' },
  { name: 'set', insert: 'set  = ', caret: 4, doc: 'Sets a variable of the template.' },
  { name: 'endset', doc: 'Ends a set block.' },
  { name: 'with', doc: 'Variables for the block that follows.' },
  { name: 'endwith', doc: 'Ends a with.' },
  { name: 'macro', doc: 'Defines a reusable piece of template.' },
  { name: 'endmacro', doc: 'Ends a macro.' },
  { name: 'filter', doc: 'Applies a filter to the block.' },
  { name: 'endfilter', doc: 'Ends a filter block.' },
  { name: 'raw', doc: 'Leaves what follows unrendered.' },
  { name: 'endraw', doc: 'Ends raw.' },
  { name: 'break', doc: 'Leaves the loop.' },
  { name: 'continue', doc: 'Skips to the next item.' },
];

const f = (name: string, args: string, doc: string, returns?: ValueType, sig?: string): Word => ({
  ...(args === '' ? { name } : call(name, args, doc)),
  doc,
  sig: sig ?? (args === '' ? name : `${name}(${args.replaceAll("''", '…')})`),
  ...(returns ? { returns } : {}),
});

/** Filters: Jinja's built-ins and ansible.builtin's most used. */
export const FILTERS: Word[] = [
  f(
    'default',
    "''",
    'The value, or this one when it is undefined.',
    undefined,
    "default(value='', boolean=False)",
  ),
  f('d', "''", 'Short for default.', undefined, "d(value='', boolean=False)"),
  f('mandatory', '', 'Fails when the value is undefined.'),
  f('string', '', 'As text.', 'str'),
  f('int', '', 'As a whole number.', 'int', 'int(default=0, base=10)'),
  f('float', '', 'As a number with a fraction.', undefined, 'float(default=0.0)'),
  f('bool', '', 'As true or false ("yes", "on", 1 count as true).', 'bool'),
  f('length', '', 'How many items or characters.', 'int'),
  f('count', '', 'How many items or characters.', 'int'),
  f('lower', '', 'In lower case.', 'str'),
  f('upper', '', 'In upper case.', 'str'),
  f('capitalize', '', 'The first letter in upper case, the rest lower.', 'str'),
  f('title', '', 'Each word capitalized.', 'str'),
  f('trim', '', 'Without leading and trailing whitespace.', 'str'),
  f(
    'replace',
    "'', ''",
    'Each occurrence of the first text replaced with the second.',
    'str',
    'replace(old, new, count=None)',
  ),
  f(
    'regex_replace',
    "'', ''",
    'Each match of a regular expression replaced.',
    'str',
    "regex_replace(pattern, replacement='', ignorecase=False, multiline=False)",
  ),
  f(
    'regex_search',
    "''",
    'The first match of a regular expression, or none.',
    'str',
    'regex_search(pattern, *groups, ignorecase=False, multiline=False)',
  ),
  f(
    'regex_findall',
    "''",
    'Every match of a regular expression.',
    'list',
    'regex_findall(pattern, ignorecase=False, multiline=False)',
  ),
  f('regex_escape', '', 'The text with regular expression characters escaped.', 'str'),
  f('split', "''", 'The text split into a list.', 'list', 'split(separator=None, maxsplit=-1)'),
  f('join', "''", 'The items joined into text.', 'str', "join(separator='', attribute=None)"),
  f('first', '', 'The first item.'),
  f('last', '', 'The last item.'),
  f('list', '', 'As a list.', 'list'),
  f(
    'sort',
    '',
    'The items in order.',
    'list',
    'sort(reverse=False, case_sensitive=False, attribute=None)',
  ),
  f('reverse', '', 'The items or characters in reverse order.'),
  f('unique', '', 'The items without repeats.', 'list'),
  f('flatten', '', 'Nested lists made into one list.', 'list', 'flatten(levels=None)'),
  f(
    'map',
    "''",
    'Applies a filter, or takes an attribute, of each item.',
    'list',
    'map(filter, *args) or map(attribute=name)',
  ),
  f('select', "''", 'The items a test passes.', 'list', 'select(test, *args)'),
  f('reject', "''", 'The items a test fails.', 'list', 'reject(test, *args)'),
  f(
    'selectattr',
    "''",
    'The items whose attribute passes a test.',
    'list',
    'selectattr(attribute, test, *args)',
  ),
  f(
    'rejectattr',
    "''",
    'The items whose attribute fails a test.',
    'list',
    'rejectattr(attribute, test, *args)',
  ),
  f('groupby', "''", 'The items grouped by an attribute.', 'list', 'groupby(attribute)'),
  f('sum', '', 'The sum of the items.', undefined, 'sum(attribute=None, start=0)'),
  f('min', '', 'The smallest item.'),
  f('max', '', 'The largest item.'),
  f('abs', '', 'The absolute value.'),
  f('round', '', 'Rounded.', undefined, "round(precision=0, method='common')"),
  f('random', '', 'A random item, or a random number below the value.'),
  f('shuffle', '', 'The items in random order.', 'list'),
  f('batch', '', 'The items in lists of n.', 'list', 'batch(n, fill_with=None)'),
  f('slice', '', 'The items in n lists.', 'list', 'slice(n, fill_with=None)'),
  f('dictsort', '', 'A dict as (key, value) pairs, sorted.', 'list'),
  f('items', '', "A dict's (key, value) pairs.", 'list'),
  f(
    'dict2items',
    '',
    'A dict as a list of {key, value}.',
    'list',
    "dict2items(key_name='key', value_name='value')",
  ),
  f(
    'items2dict',
    '',
    'A list of {key, value} as a dict.',
    'dict',
    "items2dict(key_name='key', value_name='value')",
  ),
  f(
    'combine',
    '',
    'Dicts merged; later ones win.',
    'dict',
    "combine(*dicts, recursive=False, list_merge='replace')",
  ),
  f('zip', '', 'Lists paired item by item.', 'list', 'zip(*lists)'),
  f(
    'zip_longest',
    '',
    'Lists paired to the longest one.',
    'list',
    'zip_longest(*lists, fillvalue=None)',
  ),
  f('difference', '', 'The items not in the other list.', 'list', 'difference(other)'),
  f('intersect', '', 'The items also in the other list.', 'list', 'intersect(other)'),
  f('union', '', 'The items of both lists, once each.', 'list', 'union(other)'),
  f(
    'symmetric_difference',
    '',
    'The items in only one of the lists.',
    'list',
    'symmetric_difference(other)',
  ),
  f(
    'subelements',
    "''",
    'Each item paired with each element of its sub-list.',
    'list',
    'subelements(key, skip_missing=False)',
  ),
  f(
    'extract',
    '',
    'The values of these keys in a container.',
    undefined,
    'extract(container, morekeys=None)',
  ),
  f(
    'ternary',
    "'', ''",
    'The first value if true, else the second.',
    undefined,
    'ternary(true_val, false_val, none_val=None)',
  ),
  f('to_json', '', 'As JSON text.', 'str', 'to_json(indent=None, sort_keys=False)'),
  f('to_nice_json', '', 'As indented JSON text.', 'str', 'to_nice_json(indent=4, sort_keys=True)'),
  f('from_json', '', 'JSON text as data.'),
  f('to_yaml', '', 'As YAML text.', 'str'),
  f('to_nice_yaml', '', 'As indented YAML text.', 'str', 'to_nice_yaml(indent=4)'),
  f('from_yaml', '', 'YAML text as data.'),
  f('from_yaml_all', '', 'Each document of YAML text, as data.', 'list'),
  f('b64encode', '', 'As Base64.', 'str'),
  f('b64decode', '', 'Base64 decoded.', 'str'),
  f('hash', "''", 'A hash of the text.', 'str', "hash(hashtype='sha1')"),
  f('checksum', '', 'The SHA-1 checksum of the text.', 'str'),
  f('md5', '', 'The MD5 hash of the text.', 'str'),
  f('sha1', '', 'The SHA-1 hash of the text.', 'str'),
  f(
    'password_hash',
    "''",
    'A password hash for /etc/shadow.',
    'str',
    "password_hash(hashtype='sha512', salt=None)",
  ),
  f('to_uuid', '', 'A UUID made from the text.', 'str'),
  f('quote', '', 'Quoted for a shell.', 'str'),
  f('comment', '', 'As a comment block.', 'str', "comment(style='plain')"),
  f(
    'indent',
    '',
    'Each line after the first indented.',
    'str',
    'indent(width=4, first=False, blank=False)',
  ),
  f('center', '', 'Centred in a width.', 'str', 'center(width=80)'),
  f('truncate', '', 'Cut to a length.', 'str', "truncate(length=255, killwords=False, end='...')"),
  f('wordcount', '', 'How many words.', 'int'),
  f('wordwrap', '', 'Wrapped at a width.', 'str', 'wordwrap(width=79)'),
  f('format', '', 'printf-style formatting: "%s-%d" | format(a, b).', 'str', 'format(*args)'),
  f('basename', '', 'The last part of a path.', 'str'),
  f('dirname', '', 'A path without its last part.', 'str'),
  f('path_join', '', 'Parts joined into a path.', 'str'),
  f('splitext', '', 'A path split into (root, extension).', 'list'),
  f('realpath', '', 'The path with links resolved (on the controller).', 'str'),
  f('relpath', "''", 'The path relative to a start.', 'str', 'relpath(start)'),
  f('expanduser', '', 'The path with ~ expanded.', 'str'),
  f('expandvars', '', 'The path with environment variables expanded.', 'str'),
  f('fileglob', '', 'The controller files matching a pattern.', 'list'),
  f('urlsplit', "''", 'A URL split into parts, or one part.', undefined, 'urlsplit(query=None)'),
  f('urlencode', '', 'Encoded for a URL.', 'str'),
  f('urldecode', '', 'Decoded from a URL.', 'str'),
  f('human_readable', '', 'A byte count as text (1.0 KB).', 'str'),
  f('human_to_bytes', '', 'Text like 1 KB as a byte count.', 'int'),
  f(
    'to_datetime',
    "''",
    'Text as a datetime, read with strftime codes.',
    'datetime',
    "to_datetime(format='%Y-%m-%d %H:%M:%S')",
  ),
  f(
    'strftime',
    '',
    "Seconds since 1970 (or now) formatted with the codes in the value: '%Y-%m-%d' | strftime.",
    'str',
    'strftime(second=None, utc=False)',
  ),
  f('type_debug', '', 'The Python type of the value.', 'str'),
  f('tojson', '', 'As JSON text (Jinja).', 'str'),
  f('pprint', '', 'Pretty-printed, for debugging.', 'str'),
  f('attr', "''", 'An attribute of the object.', undefined, 'attr(name)'),
  f('xmlattr', '', 'A dict as XML attributes.', 'str'),
  f('escape', '', 'HTML-escaped.', 'str'),
  f('safe', '', 'Marked safe: not escaped.', 'str'),
  f('striptags', '', 'Without HTML or XML tags.', 'str'),
  f('urlize', '', 'URLs made into links.', 'str'),
  f('filesizeformat', '', 'A byte count as text (1.0 kB).', 'str'),
  f('log', '', 'The logarithm.', undefined, 'log(base=e)'),
  f('pow', '', 'Raised to a power.', undefined, 'pow(exponent)'),
  f('root', '', 'A root.', undefined, 'root(base=2)'),
  f('product', '', 'The cartesian product of lists.', 'list'),
  f('permutations', '', 'The permutations of the items.', 'list'),
  f('combinations', '', 'The combinations of n items.', 'list', 'combinations(n)'),
  f('vault', "''", 'Encrypted with a vault secret.', 'str', 'vault(secret, vault_id=None)'),
  f('unvault', "''", 'Decrypted with a vault secret.', 'str', 'unvault(secret, vault_id=None)'),
];

/** Tests, after `is` or `is not`. */
export const TESTS: Word[] = [
  f('defined', '', 'The variable is defined.'),
  f('undefined', '', 'The variable is not defined.'),
  f('none', '', 'The value is none.'),
  f('truthy', '', 'The value counts as true.'),
  f('falsy', '', 'The value counts as false.'),
  f('true', '', 'The value is true.'),
  f('false', '', 'The value is false.'),
  f('boolean', '', 'The value is true or false.'),
  f('string', '', 'The value is text.'),
  f('number', '', 'The value is a number.'),
  f('integer', '', 'The value is a whole number.'),
  f('float', '', 'The value is a number with a fraction.'),
  f('mapping', '', 'The value is a dict.'),
  f('sequence', '', 'The value is a list or text.'),
  f('iterable', '', 'The value can be looped over.'),
  f('callable', '', 'The value can be called.'),
  f('even', '', 'An even number.'),
  f('odd', '', 'An odd number.'),
  f('divisibleby', '', 'Divisible by a number.', undefined, 'divisibleby(num)'),
  f('eq', '', 'Equal to.', undefined, 'eq(other)'),
  f('ne', '', 'Not equal to.', undefined, 'ne(other)'),
  f('lt', '', 'Less than.', undefined, 'lt(other)'),
  f('le', '', 'Less than or equal to.', undefined, 'le(other)'),
  f('gt', '', 'Greater than.', undefined, 'gt(other)'),
  f('ge', '', 'Greater than or equal to.', undefined, 'ge(other)'),
  f('in', '', 'In a list or text.', undefined, 'in(container)'),
  f('lower', '', 'All lower case.'),
  f('upper', '', 'All upper case.'),
  f('sameas', '', 'The same object.', undefined, 'sameas(other)'),
  f(
    'match',
    "''",
    'A regular expression matches at the start.',
    undefined,
    'match(pattern, ignorecase=False, multiline=False)',
  ),
  f(
    'search',
    "''",
    'A regular expression matches anywhere.',
    undefined,
    'search(pattern, ignorecase=False, multiline=False)',
  ),
  f(
    'regex',
    "''",
    'A regular expression matches.',
    undefined,
    "regex(pattern, ignorecase=False, multiline=False, match_type='search')",
  ),
  f('contains', '', 'The list contains the item.', undefined, 'contains(item)'),
  f('any', '', 'Any item is true.'),
  f('all', '', 'Every item is true.'),
  f('subset', '', 'Every item is in the other list.', undefined, 'subset(other)'),
  f('superset', '', 'Holds every item of the other list.', undefined, 'superset(other)'),
  f(
    'version',
    "'', ''",
    "Compares versions: x is version('17.9', '<').",
    undefined,
    "version(version, operator='eq', strict=False, version_type=None)",
  ),
  f('changed', '', 'A task result that changed something.'),
  f('failed', '', 'A task result that failed.'),
  f('succeeded', '', 'A task result that succeeded.'),
  f('success', '', 'A task result that succeeded.'),
  f('skipped', '', 'A task result that was skipped.'),
  f('reachable', '', 'A task result whose host was reachable.'),
  f('unreachable', '', 'A task result whose host was unreachable.'),
  f('finished', '', 'An async result that finished.'),
  f('started', '', 'An async result that started.'),
  f('timedout', '', 'A task result that timed out.'),
  f('exists', '', 'The path exists on the controller.'),
  f('file', '', 'The path is a file on the controller.'),
  f('directory', '', 'The path is a folder on the controller.'),
  f('link', '', 'The path is a link on the controller.'),
  f('abs', '', 'The path is absolute.'),
  f('same_file', '', 'Both paths are the same file.', undefined, 'same_file(other)'),
  f('mount', '', 'The path is a mount point on the controller.'),
  f('url', '', 'The text is a URL.'),
  f('uri', '', 'The text is a URI.'),
  f('vault_encrypted', '', 'The value is vault-encrypted.'),
  f('nan', '', 'Not a number.'),
];

/** Lookup plugins, in `lookup('…')` and `query('…')`. */
export const LOOKUPS: Word[] = [
  { name: 'env', doc: "An environment variable on the controller: lookup('env', 'HOME')." },
  { name: 'file', doc: 'The text of controller files.' },
  { name: 'template', doc: 'Controller templates, rendered.' },
  { name: 'vars', doc: 'Variables by name.' },
  { name: 'varnames', doc: 'The names of variables matching a pattern.' },
  { name: 'pipe', doc: 'The output of a command on the controller.' },
  { name: 'lines', doc: 'The output of a command, line by line.' },
  { name: 'password', doc: 'A random password, kept in a controller file.' },
  { name: 'url', doc: 'The content of URLs.' },
  { name: 'fileglob', doc: 'Controller files matching a pattern.' },
  { name: 'first_found', doc: 'The first controller file that exists.' },
  { name: 'ini', doc: 'Values from an INI file.' },
  { name: 'csvfile', doc: 'Values from a CSV file.' },
  { name: 'sequence', doc: 'A sequence of numbers as text.' },
  { name: 'items', doc: 'The items of lists.' },
  { name: 'list', doc: 'The terms as a list.' },
  { name: 'dict', doc: "A dict's items as {key, value}." },
  { name: 'indexed_items', doc: 'The items with their index.' },
  { name: 'nested', doc: 'Every combination of the lists.' },
  { name: 'together', doc: 'The lists paired item by item.' },
  { name: 'subelements', doc: 'Items with each element of a sub-list.' },
  { name: 'random_choice', doc: 'One of the terms, at random.' },
  { name: 'inventory_hostnames', doc: 'The hosts matching an inventory pattern.' },
  { name: 'config', doc: 'An Ansible configuration setting.' },
  { name: 'unvault', doc: 'The text of vault-encrypted files.' },
];

const m = (
  name: string,
  args: string | undefined,
  doc: string,
  returns?: ValueType,
  sig?: string,
): Word =>
  args === undefined
    ? { name, doc, ...(returns ? { returns } : {}) }
    : { ...call(name, args, doc), sig: sig ?? `${name}(${args})`, ...(returns ? { returns } : {}) };

/** The members of values, after a `.`. */
export const MEMBERS: Record<ValueType, Word[]> = {
  datetime: [
    m('strftime', "''", 'Formatted with strftime codes.', 'str', 'strftime(format)'),
    m('isoformat', '', 'As ISO 8601 text.', 'str'),
    m('timestamp', '', 'Seconds since 1970.', undefined),
    m('date', '', 'The date part.', 'date'),
    m('time', '', 'The time part.', 'time'),
    m('year', undefined, 'The year.', 'int'),
    m('month', undefined, 'The month, 1 to 12.', 'int'),
    m('day', undefined, 'The day of the month.', 'int'),
    m('hour', undefined, 'The hour, 0 to 23.', 'int'),
    m('minute', undefined, 'The minute.', 'int'),
    m('second', undefined, 'The second.', 'int'),
    m('microsecond', undefined, 'The microsecond.', 'int'),
    m('weekday', '', 'The day of the week, Monday 0.', 'int'),
    m('isoweekday', '', 'The day of the week, Monday 1.', 'int'),
    m(
      'replace',
      '',
      'The same date and time with some parts changed.',
      'datetime',
      'replace(year=…, month=…, day=…, hour=…, …)',
    ),
    m('ctime', '', 'As text like "Thu Nov 12 10:15:30 2026".', 'str'),
  ],
  date: [
    m('strftime', "''", 'Formatted with strftime codes.', 'str', 'strftime(format)'),
    m('isoformat', '', 'As ISO 8601 text.', 'str'),
    m('year', undefined, 'The year.', 'int'),
    m('month', undefined, 'The month, 1 to 12.', 'int'),
    m('day', undefined, 'The day of the month.', 'int'),
    m('weekday', '', 'The day of the week, Monday 0.', 'int'),
    m('isoweekday', '', 'The day of the week, Monday 1.', 'int'),
  ],
  time: [
    m('strftime', "''", 'Formatted with strftime codes.', 'str', 'strftime(format)'),
    m('isoformat', '', 'As ISO 8601 text.', 'str'),
    m('hour', undefined, 'The hour, 0 to 23.', 'int'),
    m('minute', undefined, 'The minute.', 'int'),
    m('second', undefined, 'The second.', 'int'),
  ],
  timedelta: [
    m('days', undefined, 'Whole days.', 'int'),
    m('seconds', undefined, 'Seconds past the whole days.', 'int'),
    m('total_seconds', '', 'The whole duration in seconds.'),
  ],
  str: [
    m('upper', '', 'In upper case.', 'str'),
    m('lower', '', 'In lower case.', 'str'),
    m(
      'strip',
      '',
      'Without leading and trailing whitespace (or these characters).',
      'str',
      'strip(chars=None)',
    ),
    m('lstrip', '', 'Without leading whitespace.', 'str', 'lstrip(chars=None)'),
    m('rstrip', '', 'Without trailing whitespace.', 'str', 'rstrip(chars=None)'),
    m(
      'split',
      '',
      'Split into a list, at whitespace or a separator.',
      'list',
      'split(sep=None, maxsplit=-1)',
    ),
    m('rsplit', '', 'Split from the right.', 'list', 'rsplit(sep=None, maxsplit=-1)'),
    m('splitlines', '', 'Split into lines.', 'list'),
    m('replace', "'', ''", 'Each occurrence replaced.', 'str', 'replace(old, new, count=-1)'),
    m('startswith', "''", 'Starts with the text.', 'bool', 'startswith(prefix)'),
    m('endswith', "''", 'Ends with the text.', 'bool', 'endswith(suffix)'),
    m('find', "''", 'Where the text first is, or -1.', 'int', 'find(sub)'),
    m('count', "''", 'How many times the text occurs.', 'int', 'count(sub)'),
    m('join', '', 'The items joined with this text.', 'str', 'join(items)'),
    m('format', '', 'With {} placeholders filled.', 'str', 'format(*args, **kwargs)'),
    m('capitalize', '', 'The first letter in upper case.', 'str'),
    m('title', '', 'Each word capitalized.', 'str'),
    m('zfill', '', 'Padded with zeros to a width.', 'str', 'zfill(width)'),
    m('ljust', '', 'Padded on the right to a width.', 'str', 'ljust(width)'),
    m('rjust', '', 'Padded on the left to a width.', 'str', 'rjust(width)'),
    m('isdigit', '', 'Only digits.', 'bool'),
  ],
  list: [
    m('index', '', 'Where the item first is.', 'int', 'index(item)'),
    m('count', '', 'How many times the item occurs.', 'int', 'count(item)'),
  ],
  dict: [
    m('keys', '', 'The keys.', 'list'),
    m('values', '', 'The values.', 'list'),
    m('items', '', 'The (key, value) pairs.', 'list'),
    m('get', "''", 'The value of a key, or a default.', undefined, 'get(key, default=None)'),
  ],
  int: [],
  bool: [],
  loop: [
    m('index', undefined, 'The iteration, from 1.', 'int'),
    m('index0', undefined, 'The iteration, from 0.', 'int'),
    m('revindex', undefined, 'Iterations left, to 1.', 'int'),
    m('revindex0', undefined, 'Iterations left, to 0.', 'int'),
    m('first', undefined, 'The first iteration.', 'bool'),
    m('last', undefined, 'The last iteration.', 'bool'),
    m('length', undefined, 'How many items.', 'int'),
    m('previtem', undefined, 'The previous item.'),
    m('nextitem', undefined, 'The next item.'),
    m('cycle', '', 'One of the values in turn.', undefined, 'cycle(*values)'),
  ],
};

/** The value a filter gives, for the members after it: `(x | to_datetime).`. */
export const FILTER_RETURNS: Record<string, ValueType> = Object.fromEntries(
  FILTERS.flatMap((w) => (w.returns ? [[w.name, w.returns]] : [])),
);

/** What common result fields hold, where the module's docs give no type. */
export const FIELD_TYPES: Record<string, ValueType> = {
  stdout: 'str',
  stderr: 'str',
  msg: 'str',
  stdout_lines: 'list',
  stderr_lines: 'list',
  results: 'list',
  rc: 'int',
  changed: 'bool',
  failed: 'bool',
  json: 'dict',
};

/** strftime's codes, with what they stand for. */
export const STRFTIME_CODES: { code: string; doc: string }[] = [
  { code: '%Y', doc: 'Year, 4 digits' },
  { code: '%y', doc: 'Year, 2 digits' },
  { code: '%m', doc: 'Month, 01 to 12' },
  { code: '%d', doc: 'Day of the month, 01 to 31' },
  { code: '%H', doc: 'Hour, 00 to 23' },
  { code: '%I', doc: 'Hour, 01 to 12' },
  { code: '%p', doc: 'AM or PM' },
  { code: '%M', doc: 'Minute, 00 to 59' },
  { code: '%S', doc: 'Second, 00 to 59' },
  { code: '%f', doc: 'Microsecond, 6 digits' },
  { code: '%a', doc: 'Weekday, short name' },
  { code: '%A', doc: 'Weekday, full name' },
  { code: '%w', doc: 'Weekday, Sunday 0 to Saturday 6' },
  { code: '%u', doc: 'Weekday, Monday 1 to Sunday 7' },
  { code: '%b', doc: 'Month, short name' },
  { code: '%B', doc: 'Month, full name' },
  { code: '%j', doc: 'Day of the year, 001 to 366' },
  { code: '%U', doc: 'Week of the year, weeks start on Sunday' },
  { code: '%W', doc: 'Week of the year, weeks start on Monday' },
  { code: '%V', doc: 'ISO week, 01 to 53' },
  { code: '%G', doc: 'ISO year (with %V)' },
  { code: '%z', doc: 'UTC offset; empty for a date without a time zone' },
  { code: '%Z', doc: 'Time zone name; empty for a date without a time zone' },
  { code: '%s', doc: 'Seconds since 1970 (Linux)' },
  { code: '%c', doc: 'Date and time, locale style' },
  { code: '%x', doc: 'Date, locale style' },
  { code: '%X', doc: 'Time, locale style' },
  { code: '%%', doc: 'A % sign' },
];

/** Formats people use most, as `strftime('…')` arguments. */
export const STRFTIME_PRESETS: { format: string; doc: string }[] = [
  { format: '%Y-%m-%d %H:%M:%S', doc: 'Date and time' },
  { format: '%Y%m%d_%H%M%S', doc: 'A stamp for file names' },
  { format: '%Y-%m-%d', doc: 'Date' },
  { format: '%H:%M:%S', doc: 'Time' },
  { format: '%Y-%m-%dT%H:%M:%S', doc: 'ISO 8601 date and time' },
  { format: '%Y%m%d', doc: 'Compact date' },
  { format: '%d %b %Y', doc: 'Day, month name, year' },
  { format: '%s', doc: 'Seconds since 1970 (Linux)' },
];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Python's strftime on a date, for previews (C locale). `utc` reads the date's UTC fields. The
 * date has no time zone, as `now()` gives, so %z and %Z are empty.
 */
export function strftime(format: string, date: Date, utc = false): string {
  const get = {
    Y: utc ? date.getUTCFullYear() : date.getFullYear(),
    m: (utc ? date.getUTCMonth() : date.getMonth()) + 1,
    d: utc ? date.getUTCDate() : date.getDate(),
    H: utc ? date.getUTCHours() : date.getHours(),
    M: utc ? date.getUTCMinutes() : date.getMinutes(),
    S: utc ? date.getUTCSeconds() : date.getSeconds(),
    ms: utc ? date.getUTCMilliseconds() : date.getMilliseconds(),
    w: utc ? date.getUTCDay() : date.getDay(),
  };
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const start = Date.UTC(get.Y, 0, 1);
  const today = Date.UTC(get.Y, get.m - 1, get.d);
  const yday = Math.round((today - start) / 86_400_000) + 1;
  // C's rule: weeks start on Sunday (%U) or Monday (%W); days before the first are week 0.
  const weekOf = (firstDay: number) =>
    Math.floor((yday - 1 + 7 - ((get.w - firstDay + 7) % 7)) / 7);
  const iso = () => {
    const t = new Date(today);
    const dow = (get.w + 6) % 7;
    t.setUTCDate(t.getUTCDate() - dow + 3);
    const year = t.getUTCFullYear();
    const first = new Date(Date.UTC(year, 0, 4));
    const week =
      1 +
      Math.round(
        ((t.getTime() - first.getTime()) / 86_400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7,
      );
    return { year, week };
  };
  const h12 = get.H % 12 === 0 ? 12 : get.H % 12;
  const one = (c: string): string | undefined => {
    switch (c) {
      case 'Y':
        return String(get.Y);
      case 'y':
        return pad(get.Y % 100);
      case 'm':
        return pad(get.m);
      case 'd':
        return pad(get.d);
      case 'e':
        return String(get.d).padStart(2, ' ');
      case 'H':
        return pad(get.H);
      case 'I':
        return pad(h12);
      case 'p':
        return get.H < 12 ? 'AM' : 'PM';
      case 'M':
        return pad(get.M);
      case 'S':
        return pad(get.S);
      case 'f':
        return pad(get.ms * 1000, 6);
      case 'a':
        return (DAYS[get.w] ?? '').slice(0, 3);
      case 'A':
        return DAYS[get.w] ?? '';
      case 'w':
        return String(get.w);
      case 'u':
        return String(get.w === 0 ? 7 : get.w);
      case 'b':
      case 'h':
        return (MONTHS[get.m - 1] ?? '').slice(0, 3);
      case 'B':
        return MONTHS[get.m - 1] ?? '';
      case 'j':
        return pad(yday, 3);
      case 'U':
        return pad(weekOf(0));
      case 'W':
        return pad(weekOf(1));
      case 'V':
        return pad(iso().week);
      case 'G':
        return String(iso().year);
      case 'z':
      case 'Z':
        return '';
      case 's':
        return String(Math.floor(date.getTime() / 1000));
      case 'c':
        return `${one('a')} ${one('b')} ${String(get.d).padStart(2, ' ')} ${one('H')}:${one('M')}:${one('S')} ${get.Y}`;
      case 'x':
        return `${one('m')}/${one('d')}/${one('y')}`;
      case 'X':
        return `${one('H')}:${one('M')}:${one('S')}`;
      case 'D':
        return `${one('m')}/${one('d')}/${one('y')}`;
      case 'F':
        return `${get.Y}-${one('m')}-${one('d')}`;
      case 'T':
        return `${one('H')}:${one('M')}:${one('S')}`;
      case '%':
        return '%';
      default:
        return undefined;
    }
  };
  return format.replace(/%([-_0^#]?)([A-Za-z%])/g, (all, flag: string, c: string) => {
    let v = one(c);
    if (v === undefined) return all;
    // glibc's flags: `-` drops the padding, `_` pads with spaces, `^` upper-cases.
    if (flag === '-') v = v.replace(/^[0 ]+(?=.)/, '');
    else if (flag === '_') v = v.replace(/^0+(?=.)/, (z) => ' '.repeat(z.length));
    else if (flag === '^') v = v.toUpperCase();
    return v;
  });
}
