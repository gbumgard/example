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


exports.handler = async (event,context) => {

  console.log([event,context,process.env])

  try {

    if (event.RequestType === "Delete") {
      // Delete request should always report succes to avoid hanging the stack in a delete or rollback
      await sendCFResponse(event, context, "SUCCESS", {}).catch(e => {});
      return event;
    }


    var config = await (async () => {
      const sts = new AWS.STS();
      const { Account: account } = await sts.getCallerIdentity({}).promise();
      const { ARN: secretArn } = await secretsmanager.describeSecret({ SecretId: event.ResourceProperties.SecretArn }).promise();
      var clusterArn = event.ResourceProperties.ClusterArn;
      return { account, clusterArn, secretArn };
    })();
  
    var rdsArgs = {
      secretArn: config.secretArn,
      resourceArn: config.clusterArn,
      sql: "",
      database: "",
      includeResultMetadata: true
    }

    var delimiter = event.ResourceProperties.Delimiter;

    if (!delimiter) delimiter = ";";

    var initDb = "DELIMITER " + delimiter + "\n";

    if (event.ResourceProperties.Database) {
      // Create the database if it does not yet exist
      initDb += "CREATE DATABASE IF NOT EXISTS " + event.ResourceProperties.Database + delimiter;
      initDb += "USE " + event.ResourceProperties.Database + delimiter;
    }
  
    var physicalResourceId;

    if (event.ResourceProperties.CreateSqlDocument === null) {
      event.ResourceProperties.CreateSqlDocument = initDb;
    }
    else {
      event.ResourceProperties.CreateSqlDocument = initDb + event.ResourceProperties.CreateSqlDocument;
    }

    // Use hash of the Create document as the physical resource ID.
    // The hash is used to detect changes in the Create document.
    physicalResourceId = crypto.createHash('md5').update(event.ResourceProperties.CreateSqlDocument).digest('hex');

    var sql = "";

    if (event.RequestType == "Create") {
    
      sql = event.ResourceProperties.CreateSqlDocument;

      // The function must return a physical resource ID for the resource.
      // This value will be sent in the next event and used to check for SQL property changes
      event.PhysicalResourceId = physicalResourceId;
    
    }
    else if (event.RequestType == "Update") {

      // Use the UpdateSqlDocument property if it exists otherwise use the CreateSqlDocument property.
      if (event.ResourceProperties.UpdateSqlDocument) {

        if (event.ResourceProperties.Database) {
          rdsArgs.database = event.ResourceProperties.Database;
        }

        sql = event.ResourceProperties.UpdateSqlDocument;
      }
      else if (physicalResourceId != event.PhysicalResourceId) {

        // The physical resource ID must be updated when the resource is changed.
        // This value will be sent in the next event.
        event.PhysicalResourceId = physicalResourceId;

        sql = event.ResourceProperties.CreateSqlDocument;
      }
    }
    else {
      
      console.log("unexpected RequestType " + event.requestType);
      await sendCFResponse(event, context, "SUCCESS", {}).catch(e => {});
      return event;
    }

    var statements = parseStatements(sql, delimiter);

    console.log(statements);

    var results = [];

    // Execute each SQL statement
    for (var statement of statements) {
      if (statement.length > 0) {
        rdsArgs.sql = statement;

        var result = await executeSql(rdsArgs);

        // Store the SQL statement and the DB server response.
        results.push([rdsArgs.sql,result]);
      }
    }

    // Report success and results. The results may be used as a CF output.
    await sendCFResponse(event, context, "SUCCESS", {results: JSON.stringify(results)} ).catch(e => {});
  
  }
  catch (err) {

    // Catch everything else - the handler must send a SUCCESS response to avoid hanging stack.
    console.log(err);
    await sendCFResponse(event, context, event.RequestType == "Delete" ? "SUCCESS" : "FAILED",{}).catch(e => {});

  }

  return event;
};

let whitespace = /\s+/;

function parseStatements(sql, delimiter) {

  // Parse string of SQL statements using delimiter characters or linefeeds, as appropriate.

  var statements = [];

  while (sql.length > 0) {

    // Strip leading white space
    var c = sql[0];
    if (c === " " || c === "\n") {
      sql = sql.substring(1);
      continue;
    }
  
    // Use DELIMITER "statements" to change the delimiter value but don't execute them.

    var isDelimiterCommand = false;
    if (sql.toUpperCase().startsWith("DELIMITER")) {
      delimiter = sql.split(whitespace)[1].split('\n')[0];
      isDelimiterCommand = true;
    }
    
    // Extract the statement from the document string
    var statement = sql.substring(0,sql.indexOf(delimiter)+delimiter.length).replace('\n',' ');

    // Execute if NOT a DELIMITER command
    if (!isDelimiterCommand) statements.push(statement);

    // Advance to the next statement
    sql = sql.substring(statement.length);
  }

  return statements;

}

function executeSql(params) {
  return new Promise((resolve, reject) => {
    console.log(["Executing SQL statement:",params.sql]);
    RDS.executeStatement(params, (err, result) => {
      if (err) {
        console.warn("SQL statement '" + params.sql + "' failed with error " + err);
        reject(err)
      }
      else {
        console.log(["SQL statement '" + params.sql + "' returned result:",JSON.stringify(result)]);
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

    console.log(["Sending CloudFormation response via HTTPS:",options,responseParameters]);

    var request = https.request(options, function(response) {

      var result = {
        "statusCode": response.statusCode,
        "statusMessage": response.statusMessage,
        "headers": response.headers,
      };
  
      if (response.statusCode < 200 || response.statusCode >= 300) {
        console.log(result)
        reject(new Error("CloudFormation rejected HTTPS request with statusCode: " + response.statusCode + " statusMessage " + response.statusMessage));
      }
      else {

        let chunks = [];

        response.on('data', (data) => {
          chunks.push(data);
        });
  
        response.on('end', () => {
          console.log(chunks);
          var body = {};
          if (chunks.length > 0) {
            body = JSON.parse(chunks.toString());
          }
          result.body = body;
          console.log(result)
          resolve(body);
        });
      }
    });

    request.on("error", (err) => {
      console.log(["CloudFormation HTTPS request failed with error:",err]);
      reject(err);
    });

    request.write(responseBody);
    request.end();

  });
}