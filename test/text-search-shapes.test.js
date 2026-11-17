import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, ids, ndjson} from './helpers.js';

// Original synthetic requests preserving the installed SDK's recorded nesting,
// field conventions and scalar crop projection. No site traffic/documents.
const productRequest = term => ({
  query: {filtered: {
    query: {filtered: {query: {query_string: {query: term, analyzer: 'standard'}}, filter: {term: {'Language.Name$$string': 'en'}}}},
    filter: {term: {___types: 'Synthetic.Product'}},
  }},
  fields: ['___types', 'ContentLink.ID$$number', 'ContentLink.ProviderName$$string', 'Language.Name$$string'],
});
const contentRequest = term => ({
  query: {filtered: {
    query: {query_string: {query: term, analyzer: 'standard', fields: ['SearchTitle$$string.standard', 'SearchText$$string.standard', 'SearchSummary$$string.standard', 'SearchAttachmentText$$string.standard']}},
    filter: {or: [{term: {___types: 'Synthetic.SearchContent'}}, {term: {___types: 'Synthetic.Page'}}, {term: {___types: 'Synthetic.Media'}}]},
  }},
  fields: ['___types', 'SearchTitle$$string'],
  script_fields: {'SearchSummary$$string-cropped-12': {script: 'ascropped', lang: 'native', params: {field: 'SearchSummary$$string', length: 12}}},
});

test('SDK product query applies text and type/language filters through nested wrappers', async t => {
  const {put, search} = await gateway(t);
  const source = (title, language = 'en', type = 'Synthetic.Product') => ({'Name$$string': title, 'Language.Name$$string': language, ___types: [type], ContentLink: {'ID$$number': 42, 'ProviderName$$string': ''}});
  await put('jacket', source('Trail jacket'));
  await put('boot', source('Riding boot'));
  await put('foreign', source('Trail jacket', 'sv'));
  await put('page', source('Trail jacket', 'en', 'Synthetic.Page'));
  assert.deepEqual(ids(await search(productRequest('jacket'))), ['jacket']);
  assert.deepEqual(ids(await search(productRequest('zzqxnothing'))), []);
  const body = productRequest('jacket');
  body.query.filtered.query.filtered.query = {function_score: {
    query: {query_string: {query: 'jacket', fields: ['Name$$string.*^3']}},
    functions: [{filter: {term: {'Name$$string': 'Riding boot'}}, boost_factor: 10}],
  }};
  assert.deepEqual(ids(await search(body)), ['jacket']);
});

test('unified content shape finds indexed title, respects type/language, returns scalar crop fields in search and msearch', async t => {
  const {put, request} = await gateway(t);
  const source = (language = 'en', type = 'Synthetic.Page') => ({___types: [type], 'Language.Name$$string': language, 'SearchTitle$$string': 'Jacket care', 'SearchSummary$$string': 'Protect your outerwear in winter.'});
  await put('page', source());
  await put('foreign', source('sv'));
  await put('product', source('en', 'Synthetic.Product'));
  for (const path of ['/pages/_search', '/_msearch']) {
    for (const [term, total] of [['jacket', 1], ['zzqxnothing', 0]]) {
      const body = contentRequest(term);
      body.query = {filtered: {query: body.query, filter: {term: {'Language.Name$$string': 'en'}}}};
      const response = await request(path, {method: 'POST', body: path === '/_msearch' ? ndjson({index: 'pages'}, body) : body});
      assert.equal(response.status, 200, response.text);
      const result = path === '/_msearch' ? response.data.responses[0] : response.data;
      assert.equal(result.hits.total, total);
      if (!total) continue;
      assert.deepEqual(ids(result), ['page']);
      assert.deepEqual(result.hits.hits[0].fields, {___types: ['Synthetic.Page'], 'SearchTitle$$string': 'Jacket care', 'SearchSummary$$string-cropped-12': 'Protect your'});
      assert.equal(Object.hasOwn(result.hits.hits[0], '_source'), false);
    }
  }
});

test('complete unified SDK shape composes type alternatives, highlights, partial fields and all crop aliases', async t => {
  const {put, search} = await gateway(t);
  const source = type => ({___types: [type], 'SearchTitle$$string': 'Jacket care', 'SearchSummary$$string': 'Protect your coat', 'SearchText$$string': 'Wash your jacket gently', 'SearchAttachmentText$$string': 'Read the label', SearchMetaData: {'Topic$$string': 'Care'}});
  await put('page', source('Synthetic.Page'));
  await put('media', source('Synthetic.Media'));
  await put('product', source('Synthetic.Product'));
  await put('no-match', {...source('Synthetic.Page'), 'SearchTitle$$string': 'Footwear', 'SearchText$$string': 'Clean leather boots'});
  const body = contentRequest('jacket');
  body.partial_fields = {SearchMetaData: {include: ['SearchMetaData.*']}};
  body.highlight = {fields: {'SearchTitle$$string.standard': {pre_tags: ['|pre|'], post_tags: ['|post|'], number_of_fragments: 0}, 'SearchText$$string.standard': {pre_tags: ['|pre|'], post_tags: ['|post|'], fragment_size: 100, number_of_fragments: 2}}};
  body.script_fields = Object.fromEntries(['SearchSummary$$string', 'SearchText$$string', 'SearchAttachment$$attachment', 'SearchAttachmentText$$string'].map(field => [`${field}-cropped-200`, {script: 'ascropped', lang: 'native', params: {field, length: 200}}]));
  const result = await search(body);
  assert.deepEqual(ids(result), ['page', 'media']);
  for (const hit of result.hits.hits) {
    assert.deepEqual(hit.fields.SearchMetaData, {SearchMetaData: {'Topic$$string': 'Care'}});
    assert.equal(hit.fields['SearchSummary$$string-cropped-200'], 'Protect your coat');
    assert.equal(hit.fields['SearchText$$string-cropped-200'], 'Wash your jacket gently');
    assert.equal(hit.fields['SearchAttachment$$attachment-cropped-200'], '');
    assert.equal(hit.fields['SearchAttachmentText$$string-cropped-200'], 'Read the label');
    assert.deepEqual(hit.highlight['SearchTitle$$string.standard'], ['|pre|Jacket|post| care']);
    assert.deepEqual(hit.highlight['SearchText$$string.standard'], ['Wash your |pre|jacket|post| gently']);
  }
  body.query.filtered.query.query_string.query = 'zzqxnothing';
  assert.equal((await search(body)).hits.total, 0);
});

test('native crop handles absent text and rejects arbitrary script definitions before scanning', async t => {
  const {put, search, request} = await gateway(t);
  await put('one', {'Title$$string': 'Jacket'});
  const crop = (field, length) => ({script: 'ascropped', lang: 'native', params: {field, length}});
  const result = await search({script_fields: {missing: crop('Missing$$string', 10), zero: crop('Title$$string', 0), title: crop('Title$$string', 100)}});
  assert.deepEqual(result.hits.hits[0].fields, {missing: '', zero: '', title: 'Jacket'});
  for (const definition of [
    {...crop('Title$$string', 1), script: 'execute arbitrary code'},
    {...crop('Title$$string', 1), lang: 'javascript'},
    crop('Title$$string', -1), crop('Title$$string', 1.5),
    {...crop('Title$$string', 1), params: {field: 'Title$$string', length: 1, code: 'anything'}},
  ]) {
    const response = await request('/empty/_search', {method: 'POST', body: {script_fields: {x: definition}}});
    assert.equal(response.status, 400, response.text);
  }
});
