'use strict';

const aws = require("aws-sdk");
aws.config.update( { region: "eu-central-1" } );
const s3 = new aws.S3();
var XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
const _archiver = require('archiver');

exports.handler = async (_req, _ctx, _cb) => {
    console.log('start');
    var lockExists = false;
    var eventId = _req["Records"][0]["s3"]["object"]["key"].split('/')[0];
    var bucketName = _req["Records"][0]["s3"]["bucket"]["name"];
    var lockFileKey = eventId+'/zip/'+size+'.lock';
    var size = await countObjects(bucketName, eventId+"/");
    var zipfileKey = eventId+'/zip/'+size+'.zip';
    
    
    // Check if zip exists
    var paramsZipExist = {Bucket: bucketName, Key: zipfileKey};
    
    try { 
      await s3.headObject(paramsZipExist).promise();
      CallAPI(eventId);
      console.log("zip exists");
      return;
    } catch (headErr) {
      console.log(headErr);
    }
    
    // Check if lock exists
    var paramsLockExist = {Bucket: bucketName, Key: lockFileKey};
    
    try { 
      await s3.headObject(paramsLockExist).promise();
        lockExists = true;
      } catch (headErr) {
    }
    
    if(lockExists){
      console.log("lock exists");
      return;
    }
    await s3.putObject({
      Key: lockFileKey,
      Bucket: bucketName,
      Body: 'LOCK'
    }).promise()
    
    // Get album data from API
    var subscriptions = GetFileData(eventId);
    
    // Prepare album data for S3
    var allKeys = await prepareKeys(subscriptions,eventId+'/');
    
    // Zip
    await zipIt(allKeys, bucketName,zipfileKey);
    
    // Call API is done
    CallAPI(eventId);
    
    //Delete lock
    await s3.deleteObject(paramsLockExist).promise();
    
    _cb(null, { } );
};

function CallAPI(eventId){
  console.assert("call");
  var xhr = new XMLHttpRequest();
  xhr.open("POST", "https://devlogin.kamero.in/v1/zip_ready", false);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(JSON.stringify({
    eventDocId: eventId
  })).promise();
}

function GetFileData(eventId){
  console.assert("call");
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "https://devlogin.kamero.in/v1/zip?eventDocId="+eventId, false);
  var a = xhr.send();
  
  return JSON.parse(xhr.responseText);
}

async function prepareKeys(subscriptions, prefix){
  var allKeys=[];
  for (var key in subscriptions) {
    for(var i=0;i<subscriptions[key].length;i++){
      allKeys.push({
        from:prefix+subscriptions[key][i],
        to:key+'/'+subscriptions[key][i]
      });
    }
  }
  return allKeys;
}

//This returns us a stream.. consider it as a real pipe sending fluid to S3 bucket.. Don't forget it
const streamTo = (_bucket, _key) => {
	var stream = require('stream');
	var _pass = new stream.PassThrough();
	s3.upload( { Bucket: _bucket, Key: _key, Body: _pass }, (_err, _data) => { /*...Handle Errors Here*/ } );
	return _pass;
};


async function zipIt(allKeys, bucketName, zipfileKey){
	
	
    var _list = await Promise.all(allKeys.map(_key => new Promise((_resolve, _reject) => {
            let params = {Bucket: bucketName, Key: _key["from"]}
            //s3.getObject(params).then(_data => _resolve( { data: _data.Body, name: `${_key.split('/').pop()}` } ));
            var data = s3.getObject(params);
            _resolve( { data: data, name: _key["to"] } );
        }
    ))).catch(_err => { throw new Error(_err) } );

    await new Promise((_resolve, _reject) => { 
        var _myStream = streamTo(bucketName, zipfileKey);		//Now we instantiate that pipe...
        var _archive = _archiver('zip');
        _archive.on('error', err => { throw new Error(err); } );
        
        //Your promise gets resolved when the fluid stops running... so that's when you get to close and resolve
        _myStream.on('close', _resolve);
        _myStream.on('end', _resolve);
        _myStream.on('error', _reject);
        
        _archive.pipe(_myStream);			//Pass that pipe to _archive so it can push the fluid straigh down to S3 bucket
        _list.forEach(_itm => _archive.append(_itm.data.createReadStream(), { name: _itm.name } ) );		//And then we start adding files to it
        _archive.finalize();				//Tell is, that's all we want to add. Then when it finishes, the promise will resolve in one of those events up there
    }).catch(_err => { throw new Error(_err) } );
}

async function listAllKeys(bucketName, prefix, token)
{
  
  var listParams = { 
   Bucket: bucketName,
   Delimiter: '/',
   Prefix:prefix
  }
    
  if(token) listParams.ContinuationToken = token;

  s3.listObjectsV2(listParams, function(err, data){
      console.log(data.Contents);
      for(var i=0;i<data.Contents.length;i++){
          allKeys.push(data.Contents[i].Key);
      }

    if(data.IsTruncated)
      listAllKeys(data.NextContinuationToken);
    else
      zipIt();
  });
}

async function countObjects(bucketName, prefix, token){
  
  var countParams = { 
     Bucket: bucketName,
     Delimiter: '/',
     Prefix: prefix,
     ContinuationToken : token
    };
  
  var data = await s3.listObjectsV2(countParams).promise();
  
  if(data.IsTruncated)
    return countObjects(bucketName, prefix, data.NextContinuationToken);
  else
    return data.Contents.filter(item => item.Key.endsWith('.jpg')).length;
}
