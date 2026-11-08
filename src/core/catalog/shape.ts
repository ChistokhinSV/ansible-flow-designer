// AFD-163: a collection dump read from the catalog cache, checked before the index uses it. A file
// that parses as JSON but is not a dump (a foreign file, an older format, a half-written one)
// threw inside CatalogIndex.build and failed the whole catalog; now it costs that collection only,
// and a plugin that is not usable costs that plugin only.
import type { CatalogOption, CatalogPlugin, CollectionFile } from './types';

const isMap = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const text = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : Array.isArray(v)
      ? v.filter((x) => typeof x === 'string').join(' ')
      : '';

const name = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function option(v: unknown): CatalogOption {
  const o = isMap(v) ? v : {};
  return {
    ...o,
    type: text(o.type) || 'str',
    description: text(o.description),
    ...(Array.isArray(o.aliases) ? { aliases: o.aliases.filter(name) } : { aliases: undefined }),
  } as CatalogOption;
}

function plugin(v: unknown): CatalogPlugin | undefined {
  if (!isMap(v) || !name(v.type) || !name(v.fqcn) || !name(v.name) || !name(v.collection))
    return undefined;
  const options = isMap(v.options)
    ? Object.fromEntries(Object.entries(v.options).map(([k, o]) => [k, option(o)]))
    : undefined;
  return {
    ...v,
    short_description: text(v.short_description),
    description: text(v.description),
    notes: v.notes === undefined ? undefined : text(v.notes),
    options,
  } as CatalogPlugin;
}

/** The dump as the index reads it, or undefined when it is no collection dump at all. */
export function collectionFile(data: unknown): CollectionFile | undefined {
  if (!isMap(data) || !name(data.collection) || !Array.isArray(data.plugins)) return undefined;
  return {
    ...data,
    collection: data.collection,
    version: text(data.version),
    plugins: data.plugins.map(plugin).filter((p): p is CatalogPlugin => !!p),
    routing: isMap(data.routing) ? (data.routing as CollectionFile['routing']) : {},
    errors: Array.isArray(data.errors) ? data.errors.map(String) : [],
  } as CollectionFile;
}
