/// <reference types="vite/client" />

// Baked in at build time by vite.config's `define`. "prod" for the normal
// build, "staging" for the dedicated staging bundle (separate /staging/ path).
// Lets the staging bundle default to the staging DB without a ?env query.
declare const __CB_ENV__: string;
// SpacetimeDB host URL, baked in at build time (CB_HOST, see vite.config.ts).
declare const __CB_HOST__: string;
