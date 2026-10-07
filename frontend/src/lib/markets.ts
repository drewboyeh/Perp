/** Private-company (pre-IPO) markets: on-chain symbols end in -PRE, e.g. OPENAI-PRE. */
export const isPrivateMarket = (symbol: string) => symbol.toUpperCase().endsWith("-PRE");

/** Symbol to show in the UI: OPENAI-PRE displays as OPENAI (with a pre-IPO tag next to it). */
export const displaySymbol = (symbol: string) => (isPrivateMarket(symbol) ? symbol.slice(0, -4) : symbol);
