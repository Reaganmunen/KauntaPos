'use strict';

/**
 * The Express app. server.js starts it; keeping them apart lets you import `app` elsewhere.
 *
 *   TRUST_PROXY   number of proxies in front of the app (default 1 in production, off otherwise).
 *                 Needed so req.ip / req.hostname are the real client and public host: rate
 *                 limits, IP allow-lists and shop-by-subdomain all depend on it.
 *   API_PREFIX    default /api
 *
 * The frontend lives in ../public (a sibling of src). It is served as plain static files:
 * GET / returns public/index.html, GET /css/landing.css returns public/css/landing.css, and so on.
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const { requestContext, corsOptions, notFound, errorHandler } = require('./middleware');
const routes = require('./routes');

const prefix = (process.env.API_PREFIX || '/api').replace(/\/$/, '');
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');

const proxy = process.env.TRUST_PROXY;
if (proxy !== undefined && proxy !== '') {
  app.set('trust proxy', /^\d+$/.test(proxy) ? Number(proxy) : proxy === 'true' ? true : proxy);
} else if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(requestContext);
app.use(cors(corsOptions));

// ---------- frontend ----------
// Before the API and before notFound, so files are found first and anything else falls through.
// Pages are never cached hard (you will edit them often); css/js/images are cached for an hour in
// production. Dotfiles are ignored, and a request for a folder returns its index.html.
app.use(express.static(publicDir, {
  index: 'index.html',
  dotfiles: 'ignore',
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ---------- API ----------
// A batch of offline sales or a 1000-row product import is bigger than the 1 MB default. These two
// run first; the body parser skips a body that has already been read.
const bigJson = express.json({ limit: '5mb' });
app.use(`${prefix}/sync/sales`, bigJson);
app.use(`${prefix}/products/import`, bigJson);
app.use(express.json({ limit: '1mb' }));

app.use(prefix, routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;