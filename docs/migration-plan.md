# Apps Script to D1 migration plan

## Source of truth

The current Google Sheets workbook remains read-only evidence after cutover. Export each of the eight operational sheets before any write freeze: Users, Rooms, RoomParticipants, Visits, Penalties, Reports, Logs, and Admins.

The date-and-room columns from the older summary sheet are not database columns. They are a report view that will be rebuilt from rooms, participants, and visits.

## Import sequence

1. Export a workbook copy and one CSV per source sheet.
2. Load each CSV into staging tables with the original row number and legacy ID.
3. Validate duplicate nicknames, duplicate blog URLs, missing room references, duplicate participation, invalid visits, and inconsistent completion or penalty states.
4. Create stable UUID mappings for legacy IDs.
5. Import users, rooms, participants, visits, penalties, reports, and logs in foreign-key order.
6. Reconcile row counts and relationship counts before enabling the application.
7. Freeze Google Sheets writes, repeat the export for the final delta, and switch the frontend API base URL.

## Import safety

Past rooms must be inserted with their historical status. The scheduled close task must only process rooms whose close time has passed after the new service cutover, so that historic records never receive a second automatic penalty.
