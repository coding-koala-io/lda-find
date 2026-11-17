import {HttpError, object} from './errors.js';
import {urlOptions, integerOption} from './url-options.js';

// Fixed placeholders acknowledge the SDK contract without identifying a visitor
// or correlating events. Statistics requests never enter the document store.
const tracking = {
  status: 'ok',
  track_id: 'local-noop',
  track_uuid: '00000000-0000-0000-0000-000000000000',
  track_sid: '00000000-0000-0000-0000-000000000000',
};
const suggestions = new Map([
  ['_didyoumean', 'query'],
  ['_spellcheck', 'query'],
  ['_autocomplete', 'prefix'],
]);

/** Only the visitor Statistics wire contracts; no event retention or telemetry. */
export function handleStatistics({store, method, segments, params, text, send, json, selection}) {
  const [index, operation] = segments;
  const suggest = segments.length === 2 && method === 'GET' && suggestions.has(operation);
  const trackQuery = [2, 3].includes(segments.length) && method === 'POST' && operation === '_track';
  const trackHit = segments.length === 2 && method === 'GET' && operation === '_track';
  if (!suggest && !trackQuery && !trackHit) return false;

  const options = urlOptions(params, suggest ? [suggestions.get(operation), 'size', 'hits_cutoff', 'cutoff', 'tags'] : trackQuery ? ['sid', 'uuid'] : ['id', 'q', 'hit.id', 'hit.pos', 'tags', 'timestamp', 'sid', 'uuid']);
  for (const name of ['size', 'hits_cutoff', 'hit.pos']) if (options[name] !== undefined) integerOption(options[name], name, name === 'size' ? 1000 : Number.MAX_SAFE_INTEGER);
  if (options.cutoff !== undefined && (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(options.cutoff))) throw new HttpError(400, 'cutoff must be between zero and one');
  if (options.timestamp !== undefined && !Number.isFinite(Date.parse(options.timestamp))) throw new HttpError(400, 'timestamp must be a date');

  if (!selection(index) || index.includes(',')) throw new HttpError(400, 'Statistics require one concrete index');
  store.validateIdentity(index, 'Statistics', 'request');
  if (suggest) {
    if (!params.get(suggestions.get(operation))) throw new HttpError(400, 'A suggestion term is required');
    return send(200, {status: 'ok', hits: []});
  }
  if (trackQuery) {
    const body = object(json(text), 'Tracking body');
    if (typeof body.q !== 'string' || !body.q.length) throw new HttpError(400, 'A tracking query is required');
    const query = object(body.query, 'Tracking query');
    for (const name of ['hits', 'took']) {
      if (!Number.isSafeInteger(query[name]) || query[name] < 0) throw new HttpError(400, 'Tracking counts must be nonnegative integers');
    }
    if (query.results != null && (!Array.isArray(query.results) || !query.results.every(value => typeof value === 'string'))) throw new HttpError(400, 'Tracking results must be strings');
    return send(200, {...tracking});
  }
  return send(200, {status: 'ok', track_id: tracking.track_id});
}
