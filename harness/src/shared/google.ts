/**
 * What the Google Search page shows, as the harness reads it before and during
 * a trial (docs/google-spike.md):
 * - search: the search input is there and usable (signed-out context);
 * - offline: the browser's offline / no-network error state;
 * - unknown: none of the above appeared in time.
 */

export type GooglePageState = 'search'  |   'offline'   |   'unknown'

/** Runtime status of the Google Search target page. */
export interface GooglePageStatus{
    /** The search landing URL that was opened. */
    searchUrl: string

    /** Where the page ended up, origin and path only. */
    url:string
    state: GooglePageState

    /** True when the search box appeared and is ready for input. */
    ready: boolean
}