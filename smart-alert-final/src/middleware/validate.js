const Joi = require('joi');

function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], { abortEarly: false, stripUnknown: true });
    if (error) {
      const details = error.details.map(d => d.message);
      return res.status(400).json({ error: 'Validation failed', details });
    }
    req[property] = value;
    next();
  };
}

const schemas = {
  register: Joi.object({
    username: Joi.string().alphanum().min(3).max(30).required(),
    password: Joi.string().min(8).max(72).required(),
    displayName: Joi.string().max(60).optional(),
  }),

  login: Joi.object({
    username: Joi.string().required(),
    password: Joi.string().required(),
  }),

  createSession: Joi.object({
    name: Joi.string().max(80).optional(),
    sensitivity: Joi.number().integer().min(1).max(10).default(7),
    noiseReductionStrength: Joi.number().min(0).max(1).default(0.75),
    vadMode: Joi.number().integer().min(0).max(3).default(3),
    keywords: Joi.array().items(
      Joi.alternatives().try(
        Joi.string().min(1).max(60),
        Joi.object({
          word: Joi.string().min(1).max(60).required(),
          matchMode: Joi.string().valid('exact', 'contains', 'prefix').default('contains'),
          caseSensitive: Joi.boolean().default(false),
        })
      )
    ).default([]),
  }),

  addKeyword: Joi.object({
    word: Joi.string().min(1).max(60).required(),
    matchMode: Joi.string().valid('exact', 'contains', 'prefix').default('contains'),
    caseSensitive: Joi.boolean().default(false),
  }),

  transcript: Joi.object({
    transcript: Joi.string().min(1).max(2000).required(),
    confidence: Joi.number().min(0).max(1).optional(),
    noiseLevel: Joi.number().optional(),
    signalLevel: Joi.number().optional(),
    audioDurationMs: Joi.number().integer().optional(),
    isFinal: Joi.boolean().default(true),
  }),

  alertsQuery: Joi.object({
    limit: Joi.number().integer().min(1).max(200).default(50),
    offset: Joi.number().integer().min(0).default(0),
    since: Joi.number().integer().optional(),
  }),
};

module.exports = { validate, schemas };
