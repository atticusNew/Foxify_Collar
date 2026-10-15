# Brand and media assets served by the demo services

`atticus-lockup.svg`: the "Atticus + finch" lockup, transparent background, gold #d9ab01. The
credit-collar demo service serves it at `/assets/atticus-lockup.svg` and switches the app header
to it automatically; until the file exists, the header falls back to the live-text lockup.

`lockin-live.mp4` and `lockin-live.jpg`: the live recording on the event demo page
(`eventProtectXDemoService.ts`), a real position on a real exchange locked and hedged on Kalshi,
captioned, with the Atticus end card; the jpg is the poster frame (the receipt). Served at
`/media/lockin-live.mp4` and `/media/lockin-live.jpg` with byte ranges. Only the names listed in
`MEDIA_FILES` (`src/eventCollar/crossVenue/mediaFiles.ts`) are served; replace the files to update
the clip, or set `EVENT_X_VIDEO_URL` to serve it from elsewhere.
