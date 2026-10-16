<h1 align='center'>ETL-Active911</h1>

<p align='center'>Bring Active911 Alerts into the TAK System</p>

## Setup

1. Request a Username & Password to the Active911 with a minimum of Read Only permission for Alerts
2. Manually Log into the account and grab the AgencyID from the URL after you log in
3. Provide the above information to the ETL Active911 Integration

## Alerts as Events

Active911 never closes an alert, so every alert sent within the last `ActiveHours` becomes a CloudTAK Event, filed under
the `active911` external ID system by its alert ID:

| Event field | Source |
| ----------- | ------ |
| Name | Alert description |
| Type | MIL-STD-2525E Incident (`10034000001100000000`) |
| Priority | Alert priority - a CloudTAK priority word is taken as is, otherwise the first number with `1` as `critical`, `2` `high`, `3` `medium`, `4` and above `low` |
| Location | Address, city and state |
| Started | Time the alert was sent |
| Remarks | Groups, author and the parsed CAD notes table |
| Metadata | The full alert and its parsed `narrative` |
| Ended | `ActiveHours` after the alert was sent - the Event ends on its own at that time whether or not this layer is still polling |
| Channels | Inherited from the Connection the layer belongs to |

Every response to an alert becomes an Assignment on its Event - named after the responder with their response (`Respond`,
`Unavailable`, ...) as the role. Only Assignments carrying the `Active911 Response` remark are managed, so people assigned
to the Event by users are never modified or removed.

The Event ID, a digest of the last state written and the end time are cached per alert in the layer's ephemeral store.
A changed alert (new responses, updated CAD notes) is updated in place; an unchanged alert costs no CloudTAK API calls. Once
an alert is older than `ActiveHours` it is no longer polled and its Event has already ended on its own, so it is simply
dropped from the cache - this layer never ends an Event itself. When the cache has no record of an alert the Events
visible to the layer are indexed by external ID before a new Event is created, so an Event is never duplicated.

Writing Events without naming Channels requires a CloudTAK release newer than 13.110.1 - earlier releases reject the Event
create request.

### CloudTAK Permissions

| Permission | Purpose |
| ---------- | ------- |
| `event:create`, `event:read`, `event:update` | Create, index, update and end the Event of each alert |
| `assignment:create`, `assignment:read`, `assignment:update`, `assignment:delete` | Keep the responders of an alert in step with the Assignments of its Event |

## CAD Notes

The free text details of an alert are formatted differently by every CAD vendor. Known formats are parsed into
individual notes which are rendered as a Markdown table in the remarks and included as `metadata.narrative`.

Each agency has a `Parser` option:

| Parser | Details |
| --- | --- |
| `auto` | Default - detect the format, falling back to `raw` |
| `raw` | Leave the details as is |
| `spillman` | Spillman/Flex - `HH mm ss MM DD YYYY :  text` notes with a `Dispatch:` trailer |
| `dated-dash` | A single leading date followed by `HH:mm:ss user - text` notes with a `TIME:` trailer |

To support a new format add a parser to `lib/parsers/`, register it in `lib/parsers/index.ts` and add a scrubbed
sample of the details to `test/parsers.test.ts` - CAD notes routinely contain names & medical information.

## Development

<details><summary>Development Information</summary>

## Configuration

Setting up an Active911 ETL will require the following:

- An Active911 User/Password that can login to the [online portal](https://interface.active911.com/interface/index.php)
- The account should be created specifically for TAK and only 1 account should be used per layer as only 1 login can be active at a time
- The account must have the permissions to view Alerts to be able to export the active alerts as a CSV
- `ActiveHours` (default `6`) - hours after an alert is sent that its Event stays on the map; Active911 never closes an alert so this alone ends it

## Development

DFPC provided Lambda ETLs are currently all written in [NodeJS](https://nodejs.org/en) through the use of a AWS Lambda optimized
Docker container. Documentation for the Dockerfile can be found in the [AWS Help Center](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)

```sh
npm install
```

Add a .env file in the root directory that gives the ETL script the necessary variables to communicate with a local ETL server.
When the ETL is deployed the `ETL_API` and `ETL_LAYER` variables will be provided by the Lambda Environment

```json
{
    "ETL_API": "http://localhost:5001",
    "ETL_LAYER": "19"
}
```

To run the task, ensure the local [CloudTAK](https://github.com/dfpc-coe/CloudTAK/) server is running and then run with typescript runtime
or build to JS and run natively with node

```
ts-node task.ts
```

```
npm run build
cp .env dist/
node dist/task.js
```

### Deployment

Deployment into the CloudTAK environment for configuration is done via automatic releases to the DFPC AWS environment.

Github actions will build and push docker releases on every version tag which can then be automatically configured via the
CloudTAK API.

Non-DFPC users will need to setup their own docker => ECS build system via something like Github Actions or AWS Codebuild.

</details>
