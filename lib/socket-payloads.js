'use strict';

const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validId = value => text(value, 255);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const boolean = value => typeof value === 'boolean';
const validators = {
  connectToMaster: validId,
  'player start': value => value === undefined,
  'player pause': value => value === undefined,
  stop: value => value === undefined,
  'player timeupdate': value => finite(value) && value >= 0,
  'player volumeupdate': value => finite(value) && value >= 0 && value <= 1,
  'video url': value => {
    if (!text(value, 2048)) return false;
    try { return ['http:', 'https:'].includes(new URL(value).protocol); }
    catch { return false; }
  },
  'video uploaded': value => value !== null && typeof value === 'object' &&
    !Array.isArray(value) && validId(value.videoId),
  'toggle loop': boolean,
  'toggle inversion': boolean,
  'optimize color': boolean,
  'toggle enhance details': boolean,
  'toggle back details': boolean,
};

function validateEvent(event, args) {
  return Object.hasOwn(validators, event) && args.length <= 1 && validators[event](args[0]);
}

module.exports = { validateEvent, validId };
