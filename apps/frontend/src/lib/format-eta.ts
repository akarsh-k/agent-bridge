/** "about 40s left" / "about 9 min left" / "about 1.5 h left". Rounded
 *  coarsely on purpose: the rate drifts, and false precision reads as
 *  a promise. Shared by the Files page ingest rows and the Scorecard
 *  tab's run progress. */
export function formatEta(seconds: number): string {
  if (seconds < 5) return 'almost done'
  if (seconds < 90) return `about ${Math.round(seconds / 5) * 5}s left`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `about ${minutes} min left`
  return `about ${(seconds / 3600).toFixed(1)} h left`
}
