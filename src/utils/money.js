'use strict';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function round3(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
}

module.exports = { round2, round3 };
