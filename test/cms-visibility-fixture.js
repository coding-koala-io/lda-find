// Original synthetic profile of the CMS branches described by the query spec.
// Type names are synthetic; this is not a captured Foundation request.
export const cmsNow = '2026-11-17T12:34:00Z';
const future = '2026-11-17T12:35:00Z';
const past = '2026-11-17T12:33:00Z';
const hierarchy = name => ({terms: {___types: [`Synthetic.${name}`]}});
const not = filter => ({not: {filter}});
const guard = (type, predicate) => ({or: [not(hierarchy(type)), predicate]});
const missing = field => not({exists: {field}});
const neutralTypes = ['Synthetic.Media', 'Synthetic.Content', 'Synthetic.IVersionable', 'Synthetic.ISoftDeletable', 'Synthetic.ISecurable'];

function publicationWindow(prefix) {
  return {and: [
    {range: {[`${prefix}StartPublish$$date`]: {to: cmsNow, include_upper: true}}},
    {or: [missing(`${prefix}StopPublish$$date`), {range: {[`${prefix}StopPublish$$date`]: {from: cmsNow, include_lower: false}}}]},
  ]};
}

export function cmsVisitorFilter({authenticated = true} = {}) {
  const access = [{terms: {'RolesWithReadAccess$$string': ['Everyone', 'Readers']}}];
  if (authenticated) access.push({terms: {'UsersWithReadAccess$$strings.lowercase': ['visitor']}});
  return {and: [
    hierarchy('Content'),
    {or: [{and: [
      hierarchy('ILocalizable'),
      {or: [
        {term: {'Language.Name$$string': 'en-GB'}},
        {term: {'Language.Name$$string': 'en-gb'}},
      ]},
      {or: [publicationWindow('PublishedInLanguage.en-GB.'), publicationWindow('PublishedInLanguage.en-gb.')]},
    ]}, {and: [not(hierarchy('ILocalizable')), guard('IVersionable', {and: [
      {term: {'Status$$long': 4}}, publicationWindow(''),
    ]})]}]},
    guard('ISoftDeletable', {term: {'IsDeleted$$bool': false}}),
    guard('ISecurable', {or: access}),
    {or: [missing('SiteId$$string'), {term: {'SiteId$$string': 'synthetic-site'}}]},
    not({term: {'HasTemplate$$bool': false}}),
    not(hierarchy('ContentFolder')),
    not(hierarchy('PageContainer')),
  ]};
}

function content(id, changes = {}) {
  return {id, source: {
    $type: 'Synthetic.ArticlePage, Synthetic',
    ___types: ['Synthetic.ArticlePage', 'Synthetic.Page', 'Synthetic.Content', 'Synthetic.ILocalizable', 'Synthetic.IVersionable', 'Synthetic.ISoftDeletable', 'Synthetic.ISecurable'],
    'Title$$string': `Garden ${id}`,
    'Status$$long': 4,
    'StartPublish$$date': past,
    'IsDeleted$$bool': false,
    'RolesWithReadAccess$$string': ['Everyone'],
    'UsersWithReadAccess$$strings': [],
    'SiteId$$string': 'synthetic-site',
    Language: {'Name$$string': 'en-GB'},
    ContentLink: {'ID$$long': 1, 'ProviderName$$string': 'Default'},
    PublishedInLanguage: {'en-GB': {'StartPublish$$date': past}},
    ...changes,
  }};
}

export const cmsCorpus = [
  content('published'),
  content('starts-now', {'StartPublish$$date': cmsNow, PublishedInLanguage: {'en-GB': {'StartPublish$$date': cmsNow}}}),
  content('future-expiry', {'StopPublish$$date': future, PublishedInLanguage: {'en-GB': {'StartPublish$$date': past, 'StopPublish$$date': future}}}),
  content('lowercase-language', {Language: {'Name$$string': 'en-gb'}, PublishedInLanguage: {'en-gb': {'StartPublish$$date': past}}}),
  content('user-access', {'RolesWithReadAccess$$string': [], 'UsersWithReadAccess$$strings': ['VISITOR']}),
  content('role-access', {'RolesWithReadAccess$$string': ['Readers']}),
  content('missing-site', {'SiteId$$string': undefined}),
  content('neutral-versioned', {___types: ['Synthetic.Media', 'Synthetic.Content', 'Synthetic.IVersionable'], Language: undefined, PublishedInLanguage: undefined, 'RolesWithReadAccess$$string': undefined, 'IsDeleted$$bool': undefined}),
  content('plain-content', {___types: ['Synthetic.Content'], Language: undefined, PublishedInLanguage: undefined, 'Status$$long': undefined, 'StartPublish$$date': undefined, 'RolesWithReadAccess$$string': undefined, 'IsDeleted$$bool': undefined}),
  content('draft', {___types: neutralTypes, 'Status$$long': 2}),
  content('missing-status', {___types: neutralTypes, 'Status$$long': undefined}),
  content('future-start', {___types: neutralTypes, 'StartPublish$$date': future}),
  content('missing-start', {___types: neutralTypes, 'StartPublish$$date': undefined}),
  content('expired', {___types: neutralTypes, 'StopPublish$$date': past}),
  content('expires-now', {___types: neutralTypes, 'StopPublish$$date': cmsNow}),
  content('language-future-start', {PublishedInLanguage: {'en-GB': {'StartPublish$$date': future}}}),
  content('language-expired', {PublishedInLanguage: {'en-GB': {'StartPublish$$date': past, 'StopPublish$$date': past}}}),
  content('language-expires-now', {PublishedInLanguage: {'en-GB': {'StartPublish$$date': past, 'StopPublish$$date': cmsNow}}}),
  content('missing-language-publication', {PublishedInLanguage: {}}),
  content('wrong-language', {Language: {'Name$$string': 'sv'}}),
  content('missing-language', {Language: undefined}),
  content('deleted', {'IsDeleted$$bool': true}),
  content('missing-deleted-flag', {'IsDeleted$$bool': undefined}),
  content('restricted', {'RolesWithReadAccess$$string': ['Editors'], 'UsersWithReadAccess$$strings': ['OTHER']}),
  content('missing-acl', {'RolesWithReadAccess$$string': undefined, 'UsersWithReadAccess$$strings': undefined}),
  content('other-site', {'SiteId$$string': 'other-site'}),
  content('no-template', {'HasTemplate$$bool': false}),
  content('folder', {___types: ['Synthetic.ContentFolder', 'Synthetic.Content']}),
  content('page-container', {___types: ['Synthetic.PageContainer', 'Synthetic.Content']}),
  content('unrelated', {___types: ['Synthetic.Other']}),
].map((entry, index) => ({...entry, source: {...entry.source, ContentLink: {...entry.source.ContentLink, 'ID$$long': index + 1}}}));

export const visibleCmsIds = ['published', 'starts-now', 'future-expiry', 'lowercase-language', 'user-access', 'role-access', 'missing-site', 'neutral-versioned', 'plain-content'];
