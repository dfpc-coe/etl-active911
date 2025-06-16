<h1 align='center'>ETL-Active911</h1>

<p align='center'>Bring Active911 Alerts into the TAK System</p>

## Setup

1. Request a Username & Password to the Active911 with a minimum of Read Only permission for Alerts
2. Manually Log into the account and grab the AgencyID from the URL after you log in
3. Provide the above information to the ETL Active911 Integration

## Development

<details><summary>Development Information</summary>

## Configuration

Setting up an Active911 ETL will require the following:

- An Active911 User/Password that can login to the [online portal](https://interface.active911.com/interface/index.php)
- The account should be created specifically for TAK and only 1 account should be used per layer as only 1 login can be active at a time
- The account must have the permissions to view Alerts to be able to export the active alerts as a CSV

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
