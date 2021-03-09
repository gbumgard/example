/* Amplify Params - DO NOT EDIT
  ENV
  REGION
Amplify Params - DO NOT EDIT */

process.env.AWS_SDK_LOAD_CONFIG = 1;
const AWS = require('aws-sdk');
const crypto = require('crypto');

const RDS = new AWS.RDSDataService();
const secretsmanager = new AWS.SecretsManager();

const https = require("https");
const url = require("url");

/**
 * Handle CloudFormation "Create", "Update" and "Delete" requests.
 */
exports.handler = async (event, context) => {

  console.info(event)

  try {

    if (event.RequestType === "Delete") {
      // Delete request should always report succes to avoid hanging the stack in a delete or rollback
      await sendCFResponse(event, context, "SUCCESS", {}).catch(e => { });
      return event;
    }

    const { ARN: secretArn } = await secretsmanager.describeSecret({ SecretId: event.ResourceProperties.DBSecretArn }).promise();
    
    var rdsArgs = {
      secretArn: secretArn,
      resourceArn: event.ResourceProperties.DBClusterArn,
      sql: "",
      database: "",
      includeResultMetadata: true
    }

    var delimiter = event.ResourceProperties.SqlDelimiter;
    var database = event.ResourceProperties.DatabaseName;

    var sql = "";

    sql += "CREATE DATABASE IF NOT EXISTS " + database + delimiter;
    sql += "USE " + database + delimiter;
    sql += event.ResourceProperties.SqlScript;


    var physicalResourceId = crypto.createHash('md5').update(sql).digest('hex');

    if (physicalResourceId != event.PhysicalResourceId) {

      event.PhysicalResourceId = physicalResourceId;

      // Parse the script into individual SQL statements
      var statements = parseStatements(sql, delimiter);
      console.debug(statements);

      var results = [];

      // Execute each SQL statement
      for (var statement of statements) {
        if (statement.length > 0) {
          rdsArgs.sql = statement;
          var result = await executeSql(rdsArgs);
          // Store the SQL statement and the DB server response.
          results.push([rdsArgs.sql, result]);
        }
      }

      console.debug(results);
    }
    // Report success and results. The results may be used as a CF output.
    await sendCFResponse(event, context, "SUCCESS", {}).catch(e => { });
  }
  catch (err) {
    // Catch everything else
    // The handler must send a SUCCESS response for "Delete" avoid hanging stack on rollback.
    console.error(err);
    await sendCFResponse(event, context, event.RequestType == "Delete" ? "SUCCESS" : "FAILED", {}).catch(e => { });
  }

  return event;
};

// Regex that matches white space.
let leadingWhitespace = /^\s+/;
let whitespace = /\s+/;

/**
 * Parse a single string of SQL statements separated by delimiter characters
 * into an array of individual statements.
 */
function parseStatements(sql, delimiter) {

  var statements = [];

  while (sql.length > 0) {

    // Strip leading white space
    sql = sql.replace(leadingWhitespace, '');

    if (sql.length == 0) break;

    // Use DELIMITER "statements" to change the delimiter value but do not execute as SQL.
    var isDelimiterCommand = false;
    if (sql.toUpperCase().startsWith("DELIMITER")) {
      delimiter = sql.split(whitespace)[1].split('\n')[0];
      isDelimiterCommand = true;
    }

    // Extract the statement from the script string
    var delimiterPos = sql.indexOf(delimiter);
    if ((delimiterPos + 1) < sql.length && sql[delimiterPos + 1] == delimiter) {
      delimiterPos++;
    }

    var statement = sql.substring(0, sql.indexOf(delimiter));

    // Execute if NOT a DELIMITER command
    if (!isDelimiterCommand) statements.push(statement);

    // Advance to the next statement
    sql = sql.substring(statement.length + delimiter.length);

  }

  return statements;
}

/**
 * Execute a single SQL statement using the RDSDataService object.
 * @param {} params 
 */
function executeSql(params) {
  return new Promise((resolve, reject) => {
    RDS.executeStatement(params, (err, result) => {
      if (err) {
        console.error(`statement '${params.sql}' failed with error ${err}`);
        reject(err)
      }
      else {
        console.info(`statement '${params.sql}' returned result:`,JSON.stringify(result));
        resolve(result);
      }
    });
  });
}

function sendCFResponse(event, context, responseStatus, responseData) {

  return new Promise((resolve, reject) => {

    var responseParameters = {
      Status: responseStatus,
      Reason: "See the details in CloudWatch Log Stream: " + context.logStreamName,
      PhysicalResourceId: event.PhysicalResourceId,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: responseData
    };

    var responseBody = JSON.stringify(responseParameters);

    var parsedUrl = url.parse(event.ResponseURL);

    var options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.path,
      method: "PUT",
      headers: {
        "content-type": "",
        "content-length": responseBody.length
      }
    };

    console.info("Sending CloudFormation response:", options, responseParameters);

    var request = https.request(options, function (response) {

      var result = {
        "statusCode": response.statusCode,
        "statusMessage": response.statusMessage,
        "headers": response.headers,
      };

      if (response.statusCode < 200 || response.statusCode >= 300) {
        console.error(result)
        reject(new Error(`CloudFormation rejected HTTPS request with statusCode: ${response.statusCode} statusMessage '${response.statusMessage}'`));
      }
      else {

        let chunks = [];

        response.on('data', (data) => {
          chunks.push(data);
        });

        response.on('end', () => {
          var body = {};
          if (chunks.length > 0) {
            body = JSON.parse(chunks.toString());
          }
          result.body = body;
          console.debug(result);
          resolve(body);
        });
      }
    });

    request.on("error", (err) => {
      console.error(`CloudFormation HTTPS request failed with error: ${err.toString()}`);
      reject(err);
    });

    request.write(responseBody);
    request.end();

  });
}