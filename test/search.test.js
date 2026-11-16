import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, ids, envelope, ndjson} from './helpers.js';
import {page, visitorFilter} from './fixtures.js';
import {compile} from '../src/query.js';

test('20-page end to end: two types, visitor eligibility, hit filter, facets, sort, page and CMS projection', async t => {
  const {request, search} = await gateway(t); const records = [];
  for (let number = 1; number <= 20; number++) {
    const overrides = number === 3 ? {'RolesWithReadAccess$$string': ['Editors']} : number === 4 ? {PublishedInLanguage: {en: {'StartPublish$$date': '2026-01-01T00:00:00Z', 'StopPublish$$date': '2026-02-01T00:00:00Z'}}} : number === 5 ? {'IsDeleted$$bool': true} : number === 6 ? {Language: {'Name$$string': 'sv'}} : number === 7 ? {PublishedInLanguage: {en: {'StartPublish$$date': '2027-01-01T00:00:00Z'}}} : number === 8 ? {'SiteId$$string': 'foreign-site'} : {};
    records.push({index: {_index: 'pages', _type: number % 2 === 0 ? 'Synthetic_ArticlePage' : 'Synthetic_LandingPage', _id: `page-${number}`, language_routing: number === 6 ? 'sv' : 'en'}}, page(number, overrides));
  }
  const indexed = await request('/_bulk', {method: 'POST', body: ndjson(...records)});
  assert.equal(indexed.status, 200); assert.equal(indexed.data.items.length, 20);
  assert.ok(indexed.data.items.every(item => item.index.ok));
  const result = await search({
    query: {filtered: {query: {query_string: {query: 'garden guide', fields: ['Title$$string.en^2'], default_operator: 'AND', analyzer: 'english'}}, filter: visitorFilter}},
    filter: {term: {'___types': 'Synthetic.ArticlePage'}},
    sort: [{'Rank$$long': {order: 'desc'}}], from: 2, size: 3,
    facets: {
      categories: {terms: {field: 'Category$$string', size: 10}},
      contentTypes: {terms: {field: '$type', size: 10}},
      plants: {filter: {term: {'Category$$string': 'Plants'}}},
      pathsOnly: {terms: {field: 'Category$$string'}, facet_filter: {term: {'Category$$string': 'Paths'}}},
    },
    fields: ['ContentLink.ID$$long', 'ContentLink.ProviderName$$string', 'Language.Name$$string', '___types'],
    highlight: {fields: {'Title$$string.en': {number_of_fragments: 0}}},
  });
  envelope(result); assert.equal(result.hits.total, 7);
  assert.deepEqual(ids(result), ['page-16', 'page-14', 'page-12']);
  assert.deepEqual(result.facets.categories, {_type: 'terms', missing: 0, terms: [{term: 'Paths', count: 7}, {term: 'Plants', count: 7}]});
  assert.deepEqual(result.facets.contentTypes.terms, [{term: 'Synthetic.ArticlePage, Synthetic', count: 7}, {term: 'Synthetic.LandingPage, Synthetic', count: 7}]);
  assert.deepEqual(result.facets.plants, {_type: 'filter', count: 7});
  assert.deepEqual(result.facets.pathsOnly.terms, [{term: 'Paths', count: 7}]);
  assert.deepEqual(result.hits.hits.map(hit => hit.fields.ContentLink['ID$$long']), [16, 14, 12]);
  assert.deepEqual(result.hits.hits[0].fields.Language, {'Name$$string': 'en'});
  assert.equal(result.hits.hits[0].fields.ContentLink['ProviderName$$string'], 'Default');
  assert.equal(Object.hasOwn(result.hits.hits[0], '_source'), false);
  assert.deepEqual(result.hits.hits[0].highlight, {'Title$$string.en': ['|pre|Garden|post| |pre|guide|post| 16']});
});

test('suffix views preserve exact case, tokenize words, fold case and resolve dotted keys/arrays', async t => {
  const {put, search} = await gateway(t);
  await put('one', page(1, {'Title$$string': 'Blue Garden', 'Tags$$strings': ['One', 'Two'], 'Child': [{'Name$$string': 'Nested Garden'}], 'Literal.Path$$long': 9}));
  for (const [query, expected] of [
    [{term: {'Title$$string': 'Blue Garden'}}, ['one']],
    [{term: {'Title$$string': 'blue garden'}}, []],
    [{term: {'Title$$string.lowercase': 'blue garden'}}, ['one']],
    [{term: {'Title$$string.standard': 'garden'}}, ['one']],
    [{term: {'Title$$string.en': 'garden'}}, ['one']],
    [{term: {'Title$$string.*': 'garden'}}, ['one']],
    [{prefix: {'Title$$string.standard': 'gar'}}, ['one']],
    [{terms: {'Tags$$strings': ['Two', 'Three']}}, ['one']],
    [{term: {'Child.Name$$string.standard': 'nested'}}, ['one']],
    [{term: {'Literal.Path$$long': 9}}, ['one']],
    [{term: {'___types': 'Synthetic.Page'}}, ['one']],
    [{term: {'$type': 'Synthetic.LandingPage, Synthetic'}}, ['one']],
  ]) assert.deepEqual(ids(await search({query})), expected, JSON.stringify(query));
});

test('text matching supports phrases, explicit operators, grouping, escaping, fields and boosts', async t => {
  const {put, search} = await gateway(t);
  await put('blue', {'Title$$string': 'Blue garden', 'Body$$string': 'A quiet place'});
  await put('red', {'Title$$string': 'Red garden', 'Body$$string': 'A blue path'});
  for (const [query, expected] of [
    [{query: 'blue missing'}, ['blue', 'red']],
    [{query: 'blue missing', default_operator: 'AND'}, []],
    [{query: 'blue AND garden', fields: ['Title$$string.standard']}, ['blue']],
    [{query: '"blue garden"', fields: ['Title$$string.standard']}, ['blue']],
    [{query: '(blue OR red) AND garden NOT quiet'}, ['red']],
    [{query: 'Title$$string:Red'}, ['red']],
    [{query: 'gar*', fields: ['Title$$string.en']}, ['blue', 'red']],
    [{query: 'blue', fields: ['Title$$string^0']}, ['blue']],
  ]) assert.deepEqual(ids(await search({query: {query_string: query}})), expected, JSON.stringify(query));
  const boosted = await search({query: {query_string: {query: 'blue', fields: ['Title$$string^3', 'Body$$string']}}});
  assert.deepEqual(ids(boosted), ['blue', 'red']);
  assert.deepEqual(boosted.hits.hits.map(hit => hit._score), [3, 1]);
  const zero = await search({query: {query_string: {query: 'blue', fields: ['Title$$string^0']}}});
  assert.equal(zero.hits.hits[0]._score, 0);
  await put('punctuation', {'Title$$string': 'Garden: blue'});
  assert.deepEqual(ids(await search({query: {query_string: {query: 'Garden\\: blue', default_operator: 'AND', fields: ['Title$$string']}}})), ['blue', 'punctuation']);
});

test('Boolean filters retain must/should/not grouping, typed scalars, zero/false and existence', async t => {
  const {put, search} = await gateway(t);
  await put('one', {'N$$long': 0, 'B$$bool': false, 'Null': null, 'Empty': []});
  await put('two', {'N$$long': 2, 'B$$bool': true, 'Optional$$string': 'present'});
  const cases = [
    [{bool: {must: [{term: {'N$$long': 0}}], should: [{term: {'B$$bool': true}}]}}, ['one']],
    [{bool: {should: [{term: {'N$$long': 0}}, {term: {'B$$bool': true}}], minimum_number_should_match: 2}}, []],
    [{bool: {must_not: [{term: {'B$$bool': true}}]}}, ['one']],
    [{not: {filter: {exists: {field: 'Optional$$string'}}}}, ['one']],
    [{exists: {field: 'B$$bool'}}, ['one', 'two']],
    [{exists: {field: 'Null'}}, []],
    [{exists: {field: 'Empty'}}, []],
    [{term: {'N$$long': '0'}}, []],
    [{query: {term: {'B$$bool': false}}}, ['one']],
    [{fquery: {query: {term: {'B$$bool': false}}, _cache: true}}, ['one']],
    [{constant_score: {filter: {term: {'B$$bool': false}}, boost: 0}}, ['one']],
  ];
  for (const [query, expected] of cases) assert.deepEqual(ids(await search({query})), expected, JSON.stringify(query));
});

test('numeric/date ranges honor open bounds and minute-rounded relative dates', async t => {
  const {put, search} = await gateway(t);
  await put('one', {'N$$long': 1, 'D$$date': '2026-11-17T12:00:00Z'});
  await put('two', {'N$$long': 2, 'D$$date': '2026-11-17T12:01:00Z'});
  await put('three', {'N$$long': 3});
  assert.deepEqual(ids(await search({query: {range: {'N$$long': {from: 1, to: 3, include_lower: false, include_upper: false}}}})), ['two']);
  const now = Date.parse('2026-11-17T12:00:59Z');
  const before = compile({range: {'D$$date': {to: 'now/m'}}}, {now});
  const after = compile({range: {'D$$date': {from: 'now+1m/m'}}}, {now});
  const docs = (await search()).hits.hits.map(hit => ({source: hit._source, id: hit._id}));
  assert.deepEqual(docs.filter(doc => before(doc) !== null).map(doc => doc.id), ['one']);
  assert.deepEqual(docs.filter(doc => after(doc) !== null).map(doc => doc.id), ['two']);
});

test('sort handles several keys, string sort views, missing placement and page totals', async t => {
  const {put, search} = await gateway(t);
  await put('z', {'Title$$string': 'zebra', 'Rank$$long': 1});
  await put('a2', {'Title$$string': 'APPLE', 'Rank$$long': 2});
  await put('missing', {'Rank$$long': 3});
  await put('a1', {'Title$$string': 'apple', 'Rank$$long': 1});
  const result = await search({sort: [{'Title$$string.sort': {missing: '_first'}}, {'Rank$$long': {order: 'desc'}}], from: 1, size: 2});
  assert.equal(result.hits.total, 4); assert.deepEqual(ids(result), ['a2', 'a1']);
  assert.deepEqual(ids(await search({sort: [{'Title$$string.sort': {order: 'desc'}}]})), ['z', 'a2', 'a1', 'missing']);
  assert.equal((await search({size: 0})).hits.total, 4);
  assert.deepEqual(ids(await search({from: 100})), []);
});

test('term facets deduplicate arrays per document, count missing and run before paging/hit filters', async t => {
  const {put, search} = await gateway(t);
  await put('one', {'Tags$$strings': ['a', 'a', 'b']});
  await put('two', {'Tags$$strings': ['a']});
  await put('three', {});
  const result = await search({filter: {ids: {values: ['two']}}, size: 0, facets: {tags: {terms: {field: 'Tags$$strings'}}, words: {terms: {field: 'Tags$$strings.standard', size: 1}}}});
  assert.equal(result.hits.total, 1); assert.deepEqual(result.hits.hits, []);
  assert.deepEqual(result.facets.tags, {_type: 'terms', missing: 1, terms: [{term: 'a', count: 2}, {term: 'b', count: 1}]});
  assert.deepEqual(result.facets.words.terms, [{term: 'a', count: 2}]);
  const pastLast = await search({filter: {ids: {values: ['two']}}, from: 100, facets: {tags: {terms: {field: 'Tags$$strings'}}, words: {terms: {field: 'Tags$$strings.standard', size: 1}}}});
  assert.deepEqual(pastLast.hits.hits, []);
  assert.equal(pastLast.hits.total, result.hits.total);
  assert.deepEqual(pastLast.facets, result.facets);
});

test('partial projections retain singleton/empty arrays; selected source and hierarchy remain original', async t => {
  const {put, search} = await gateway(t);
  const source = {'Title$$string': 'garden', 'Tags$$strings': ['one'], 'Empty$$strings': [], 'Null': null, 'Object': {}, 'ContentLink': {'ID$$long': 1, 'ProviderName$$string': 'Default'}, '___types': ['Synthetic.Page'], 'Children': [{'Name$$string': 'one', 'ID$$long': 1}, {'Name$$string': 'two', 'ID$$long': 2}]};
  await put('_doc', source);
  const full = await search({partial_fields: {_all: {include: ['*']}}});
  assert.deepEqual(full.hits.hits[0].fields, source);
  const selected = await search({partial_fields: {content: {include: ['ContentLink', 'ContentLink.*'], exclude: ['ContentLink.ProviderName$$string']}}, fields: ['___types', 'Tags$$strings', 'Empty$$strings']});
  assert.deepEqual(selected.hits.hits[0].fields, {ContentLink: {'ID$$long': 1}, '___types': ['Synthetic.Page'], 'Tags$$strings': ['one'], 'Empty$$strings': []});
  const children = await search({fields: ['Children.Name$$string', 'Children.ID$$long', 'Null', 'Object']});
  assert.deepEqual(children.hits.hits[0].fields, {Children: source.Children, Null: null, Object: {}});
});

test('nested filters isolate collection objects and numeric boost composition affects order', async t => {
  const {put, search} = await gateway(t);
  await put('one', {'Items$$nested': [{'Name$$string': 'a', 'N$$long': 1}, {'Name$$string': 'b', 'N$$long': 2}]});
  await put('two', {'Items$$nested': [{'Name$$string': 'a', 'N$$long': 2}]});
  const result = await search({query: {nested: {path: 'Items$$nested', filter: {and: [{term: {'Items$$nested.Name$$string': 'a'}}, {term: {'Items$$nested.N$$long': 2}}]}}}});
  assert.deepEqual(ids(result), ['two']);
  const boosted = await search({query: {function_score: {query: {match_all: {}}, functions: [{filter: {ids: {values: ['two']}}, boost_factor: 5}], score_mode: 'sum', boost_mode: 'multiply'}}});
  assert.deepEqual(ids(boosted), ['two', 'one']);
});

test('partial projections select array children and exclude nested fields or whole parent objects', async t => {
  const {put, search} = await gateway(t);
  await put('one', {Obj: {'Secret$$string': 'hidden'}, Items: [{'Name$$string': 'public', 'Secret$$string': 'hidden'}, {'Name$$string': 'second', 'ID$$long': 2}], 'Empty': []});
  const selected = await search({partial_fields: {p: {include: ['Items.Name$$string']}}});
  assert.deepEqual(selected.hits.hits[0].fields, {Items: [{'Name$$string': 'public'}, {'Name$$string': 'second'}]});
  const excluded = await search({partial_fields: {p: {include: ['*'], exclude: ['Obj', 'Items.Secret$$string']}}});
  assert.deepEqual(excluded.hits.hits[0].fields, {Items: [{'Name$$string': 'public'}, {'Name$$string': 'second', 'ID$$long': 2}], Empty: []});
  const merged = await search({partial_fields: {names: {include: ['Items.Name$$string']}, numbers: {include: ['Items.ID$$long']}}});
  assert.deepEqual(merged.hits.hits[0].fields, {Items: [{'Name$$string': 'public'}, {'Name$$string': 'second', 'ID$$long': 2}]});
});

test('unsupported or malformed query features fail consistently even with no documents', async t => {
  const {request, put} = await gateway(t);
  const invalid = [
    {query: {query_string: {query: 'garden', fields: ['Title$$string^oops']}}},
    {query: {query_string: {query: '(garden'}}},
    {query: {query_string: {query: '*garden'}}},
    {query: {query_string: {query: 'garden', analyzer: 'synonym'}}},
    {query: {function_score: {functions: [{script_score: {script: 'decay'}}]}}},
    {query: {has_child: {type: 'x', query: {match_all: {}}}}},
    {facets: {unsupported: {histogram: {field: 'Rank$$long', interval: 10}}}},
    {sort: [{Rank: {order: 'sideways'}}]},
    {size: -1}, {size: 1001}, {from: -1},
  ];
  for (const populated of [false, true]) {
    if (populated) await put('one', page(1));
    for (const body of invalid) {
      const result = await request('/pages/_search', {method: 'POST', body});
      assert.equal(result.status, 400, JSON.stringify(body)); assert.equal(typeof result.data.error, 'string');
    }
  }
});
