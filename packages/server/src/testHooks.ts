/**
 * Test builds only (NODE_ENV=test): the E2E harness's levers on a running server. `blackout` stands in for the host
 * being gone a while — asleep, off the network — and back (SPEC J9, AC-PER-06): until `until`, no table connection is
 * accepted (the WebSocket upgrade refused), longer than the client library's own retries.
 */
export const testBlackout = { until: 0 };

export const inBlackout = (): boolean => process.env.NODE_ENV === "test" && testBlackout.until > Date.now();
