import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, ndjson, ids, envelope} from './helpers.js';
import {cmsCorpus, cmsVisitorFilter, visibleCmsIds} from './cms-visibility-fixture.js';

test('CMS visitor end to end: publication, type guards, language alternatives and access exclude invisible content', async t => {
  const {request, search} = await gateway(t);
  const bulk = await request('/_bulk', {method: 'POST', body: ndjson(...cmsCorpus.flatMap(({id, source}) => [
    {index: {_index: 'pages', _type: 'Synthetic_Content', _id: id}}, source,
  ]))});
  assert.equal(bulk.status, 200);
  assert.equal(bulk.data.items.length, 30);
  assert.ok(bulk.data.items.every(item => item.index.ok));
  assert.equal((await search()).hits.total, 30); // Visibility comes from the request.
  const body = {
    query: {filtered: {query: {query_string: {query: 'garden', fields: ['Title$$string.standard']}}, filter: cmsVisitorFilter()}},
    size: 100,
    fields: ['ContentLink.ID$$long', 'ContentLink.ProviderName$$string', 'Language.Name$$string', '___types'],
    facets: {visible: {filter: {match_all: {}}}},
  };
  const result = await search(body);
  envelope(result);
  assert.equal(result.hits.total, visibleCmsIds.length);
  assert.deepEqual(ids(result), visibleCmsIds);
  assert.equal(result.facets.visible.count, visibleCmsIds.length);
  assert.deepEqual(result.hits.hits.map(hit => hit.fields.ContentLink['ID$$long']), visibleCmsIds.map(id => cmsCorpus.findIndex(entry => entry.id === id) + 1));
  assert.ok(result.hits.hits.every(hit => hit.fields.ContentLink['ProviderName$$string'] === 'Default'));
  assert.ok(result.hits.hits.every(hit => hit.fields.___types.includes('Synthetic.Content')));
  assert.deepEqual(result.hits.hits[0].fields.Language, {'Name$$string': 'en-GB'});
  const anonymous = await search({...body, query: {constant_score: {filter: cmsVisitorFilter({authenticated: false})}}});
  assert.deepEqual(ids(anonymous), visibleCmsIds.filter(id => id !== 'user-access'));
  const pagesOnly = await search({...body, filter: {terms: {___types: ['Synthetic.Page']}}});
  assert.deepEqual(ids(pagesOnly), visibleCmsIds.filter(id => !['plain-content', 'neutral-versioned'].includes(id)));
  assert.equal(pagesOnly.facets.visible.count, visibleCmsIds.length);
});
