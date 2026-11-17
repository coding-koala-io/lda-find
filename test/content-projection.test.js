import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, ndjson} from './helpers.js';

// Independently constructed request matching a locally recorded CMS selection
// made with the installed Find SDK. No captured document or service URL is used.
const contentRequest = () => ({
  query: {constant_score: {filter: {term: {___types: 'EPiServer.Core.IContent'}}}},
  fields: ['___types', 'ContentLink.ID$$number', 'ContentLink.ProviderName$$string', 'Language.Name$$string'],
});

test('recorded CMS selection shape returns literal scalar identity keys in raw search and multi-search responses', async t => {
  const {put, request} = await gateway(t);
  await put('synthetic-page', {
    ContentLink: {'ID$$number': 271, 'ProviderName$$string': ''},
    'Language.Name$$string': 'en',
    ___types: ['Synthetic.Page', 'EPiServer.Core.IContent'],
    'Title$$string': 'Unselected content',
  });
  for (const [path, body] of [
    ['/pages/_search', contentRequest()],
    ['/_msearch', ndjson({index: 'pages'}, contentRequest())],
  ]) {
    const result = await request(path, {method: 'POST', body});
    assert.equal(result.status, 200, result.text);
    const hit = (path === '/_msearch' ? result.data.responses[0] : result.data).hits.hits[0];
    assert.deepEqual(hit.fields, {
      ___types: ['Synthetic.Page', 'EPiServer.Core.IContent'],
      'ContentLink.ID$$number': 271,
      'ContentLink.ProviderName$$string': '',
      'Language.Name$$string': 'en',
    });
    for (const token of ['"ContentLink.ID$$number":271,', '"ContentLink.ProviderName$$string":""', '"Language.Name$$string":"en"', '"_score":1.0']) {
      assert.ok(result.text.includes(token), `${token}: ${result.text}`);
    }
    assert.equal(Object.hasOwn(hit, '_source'), false);
    assert.equal(Object.hasOwn(hit.fields, 'ContentLink'), false);
    assert.equal(Object.hasOwn(hit.fields, 'Language'), false);
  }
});

test('explicit projections retain literal dotted keys, scalar null/zero/false and collection cardinality', async t => {
  const {put, request} = await gateway(t);
  const source = {
    Nested: {'ID$$number': 0, 'Zero$$number': 0, 'Enabled$$bool': false},
    'Nested.ID$$number': 7,
    Rows: [{'ID$$number': 4}, {}],
    'One$$strings': ['one'], 'Empty$$strings': [], Optional: null, Object: {},
  };
  await put('one', source);
  const fields = ['Nested.ID$$number', 'Nested.Zero$$number', 'Nested.Enabled$$bool', 'Rows.ID$$number', 'One$$strings', 'Empty$$strings', 'Optional', 'Object', 'Missing'];
  const expected = {
    'Nested.ID$$number': 7, 'Nested.Zero$$number': 0, 'Nested.Enabled$$bool': false, 'Rows.ID$$number': [4],
    'One$$strings': ['one'], 'Empty$$strings': [], Optional: null, Object: {},
  };
  for (const [path, body] of [
    ['/pages/_search', {fields}],
    [`/pages/Synthetic_ArticlePage/one?fields=${fields.join(',')}`, undefined],
  ]) {
    const result = await request(path, {method: body ? 'POST' : 'GET', body});
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(body ? result.data.hits.hits[0].fields : result.data.fields, expected);
    assert.ok(result.text.includes('"Rows.ID$$number":[4]'), result.text);
    assert.ok(result.text.includes('"Optional":null'), result.text);
  }
  assert.deepEqual((await request('/pages/Synthetic_ArticlePage/one')).data._source, source);
});

test('named partial selections wrap separate source fragments alongside literal scalar fields', async t => {
  const {put, request} = await gateway(t);
  const source = {ContentLink: {'ID$$number': 271, 'ProviderName$$string': ''}, 'Language.Name$$string': 'en', Empty: {}};
  await put('one', source);
  const result = await request('/pages/_search', {method: 'POST', body: {
    fields: ['ContentLink.ID$$number', 'Language.Name$$string'],
    partial_fields: {
      ContentLink: {include: ['ContentLink.*']},
      'Language.Name$$string': {include: ['Language.Name$$string']},
      _all: {include: ['*']},
      absent: {include: ['Missing.*']},
    },
  }});
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.data.hits.hits[0].fields, {
    'ContentLink.ID$$number': 271,
    'Language.Name$$string': {'Language.Name$$string': 'en'},
    ContentLink: {ContentLink: source.ContentLink},
    _all: source,
    absent: {},
  });
  assert.ok(result.text.includes('"ContentLink":{"ContentLink":{"ID$$number":271,'), result.text);
});

test('CMS reference IDs keep integral wire tokens across source reads and scalar/partial projections', async t => {
  const {put, request} = await gateway(t);
  await put('one', {ContentLink: {'ID$$number': 271, 'WorkID$$number': 9, 'ProviderName$$string': 'synthetic-provider'}, 'Price$$number': 2});
  for (const [path, body, flat] of [
    ['/pages/Synthetic_ArticlePage/one', undefined, false],
    ['/pages/_mget', {docs: [{_type: 'Synthetic_ArticlePage', _id: 'one'}]}, false],
    ['/pages/_search', {}, false],
    ['/pages/_search', {partial_fields: {ContentLink: {include: ['ContentLink.*']}}}, false],
    ['/pages/_search', {fields: ['ContentLink.ID$$number', 'ContentLink.WorkID$$number', 'Price$$number']}, true],
  ]) {
    const result = await request(path, {method: body ? 'POST' : 'GET', body});
    assert.equal(result.status, 200, result.text);
    for (const token of [`"${flat ? 'ContentLink.' : ''}ID$$number":271,`, `"${flat ? 'ContentLink.' : ''}WorkID$$number":9,`]) {
      assert.ok(result.text.includes(token), `${token}: ${result.text}`);
    }
    if (body?.partial_fields === undefined) assert.ok(result.text.includes('"Price$$number":2}'), result.text);
  }
});

test('PageLink, ContentLink and arbitrary integral numbers coexist with real decimals in each raw hit', async t => {
  const {put, request} = await gateway(t);
  await put('one', '{"PageLink":{"ID$$number":271,"WorkID$$number":0},"ContentLink":{"ID$$number":272,"WorkID$$number":9},"Count$$number":3,"Large$$number":9223372036854775807,"Price$$number":12.5,"WholePrice$$number":2.0,"Values$$number":[1,2.0,2.5,null]}');
  const fields = ['PageLink.ID$$number', 'PageLink.WorkID$$number', 'ContentLink.ID$$number', 'ContentLink.WorkID$$number', 'Count$$number', 'Large$$number', 'Price$$number', 'WholePrice$$number', 'Values$$number'];
  for (const [path, body, flat] of [
    ['/pages/_search', {}, false],
    ['/pages/_search', {fields}, true],
    ['/_msearch', ndjson({index: 'pages'}, {fields}), true],
    ['/pages/_search', {partial_fields: {selected: {include: ['*']}}}, false],
    ['/pages/Synthetic_ArticlePage/one', undefined, false],
    [`/pages/Synthetic_ArticlePage/one?fields=${fields.join(',')}`, undefined, true],
    ['/pages/_mget', {docs: [{_type: 'Synthetic_ArticlePage', _id: 'one'}]}, false],
  ]) {
    const result = await request(path, {method: body === undefined ? 'GET' : 'POST', body});
    assert.equal(result.status, 200, result.text);
    for (const token of [
      flat ? '"PageLink.ID$$number":271,' : '"PageLink":{"ID$$number":271,',
      flat ? '"ContentLink.ID$$number":272,' : '"ContentLink":{"ID$$number":272,',
      '"Count$$number":3,', '"Large$$number":9223372036854775807,',
      '"Price$$number":12.5,', '"WholePrice$$number":2.0,', '"Values$$number":[1,2.0,2.5,null]',
    ]) assert.ok(result.text.includes(token), `${token}: ${result.text}`);
    if (path.endsWith('_search') || path === '/_msearch') {
      assert.ok(result.text.includes('"_score":1.0'), result.text);
      assert.ok(result.text.includes('"max_score":1.0'), result.text);
    }
  }
});
