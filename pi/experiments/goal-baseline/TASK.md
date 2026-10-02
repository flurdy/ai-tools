# Repair CSV row encoding

Fix `src/csv.mjs`, which exports `encodeRow(fields)`. The input is an array of
strings; return one CSV record as a primitive string with a trailing CRLF.

Requirements:

- Separate fields with commas and preserve their order and contents.
- Enclose a field in double quotes exactly when it contains a comma, double
  quote, CR or LF; double every embedded double quote inside a quoted field.
- Exception: a single empty field must encode as `""\r\n`. An empty array
  must encode as `\r\n`. Empty fields in a multi-field row are unquoted.
- Preserve Unicode and leading/trailing spaces without unnecessary quoting.
- Leave the supplied array unchanged on return. Non-string inputs are out of scope.

Only change `src/csv.mjs`. Do not install dependencies, edit configuration,
access services, use the network, delegate work, change verification fixtures,
commit, push, merge or deploy. The operator owns trial limits and verification.

Perform available local checks within the approved environment. If a command,
permission, credential or decision is missing, stop and report the blocker;
do not seek broader access, renew limits or switch models. When finished,
report the changed file, checks actually performed and any uncertainty. Passing
self-chosen checks is not a claim that the independent verifier passed.
