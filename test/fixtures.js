/** Synthetic fields assembled from the endpoint and query specifications, never captured content. */
export function page(number, changes = {}) {
  const article = number % 2 === 0;
  return {
    '$type': `Synthetic.${article ? 'ArticlePage' : 'LandingPage'}, Synthetic`,
    '___types': [`Synthetic.${article ? 'ArticlePage' : 'LandingPage'}`, 'Synthetic.Page', 'Synthetic.IPublishable'],
    'Title$$string': `Garden guide ${number}`,
    'SearchText$$string': 'Garden paths and local plants',
    'Category$$string': number % 4 < 2 ? 'Plants' : 'Paths',
    'Rank$$long': number,
    'IsDeleted$$bool': false,
    'SiteId$$string': 'synthetic-site',
    'RolesWithReadAccess$$string': ['Everyone'],
    'UsersWithReadAccess$$strings': ['EDITOR'],
    'Language': {'Name$$string': 'en'},
    'ContentLink': {'ID$$long': number, 'ProviderName$$string': 'Default'},
    'PublishedInLanguage': {en: {'StartPublish$$date': '2026-01-01T00:00:00Z'}},
    'GetTimestamp$$date': '2026-11-17T00:00:00Z',
    ...changes,
  };
}

export const visitorFilter = {
  and: [
    {terms: {'___types': ['Synthetic.Page']}},
    {term: {'Language.Name$$string': 'en'}},
    {term: {'IsDeleted$$bool': false}},
    {or: [{not: {filter: {exists: {field: 'SiteId$$string'}}}}, {term: {'SiteId$$string': 'synthetic-site'}}]},
    {or: [{terms: {'RolesWithReadAccess$$string': ['Everyone']}}, {terms: {'UsersWithReadAccess$$strings.lowercase': ['visitor']}}]},
    {range: {'PublishedInLanguage.en.StartPublish$$date': {to: '2026-11-17T12:00:00Z', include_upper: true}}},
    {or: [{not: {filter: {exists: {field: 'PublishedInLanguage.en.StopPublish$$date'}}}}, {range: {'PublishedInLanguage.en.StopPublish$$date': {from: '2026-11-17T12:00:00Z', include_lower: false}}}]},
  ],
};
