require('dotenv').config();
const request = require('request');
const fs = require('fs');
const jimp = require('jimp');
const Rekognition = require('aws-sdk/clients/Rekognition');

const config = {
  intervalTime: process.env.INTERVAL_TIME ? parseInt(process.env.INTERVAL_TIME, 10) : 2000,
  recipientEmails: process.env.RECIPIENT_EMAILS.split(','),
  cameraName: process.env.CAMERA_NAME.trim(),
  senderUser: process.env.SENDER_USER.trim(),
  senderPassword: process.env.SENDER_PASSWORD.trim(),
  snapshotUrl: process.env.SNAPSHOT_URL.trim(),
  diffThreshold: process.env.THRESHOLD ? parseFloat(process.env.THRESHOLD, 10) : 0.15,
  confidenceThreshold: process.env.CONFIDENCE_THRESHOLD ? parseFloat(process.env.CONFIDENCE_THRESHOLD, 10) : 80,
};

const lastPath = './temp/last.jpg';
const currentPath = './temp/current.jpg';
const DETECT = 'DETECT';

const rekognition = new Rekognition({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

function saveSnapshot(path) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(path);
    stream.on('error', reject);
    stream.on('finish', resolve);
    request(config.snapshotUrl).pipe(stream);
  });
}

function snapshotsSimilar() {
  return Promise.all([lastPath, currentPath].map(path => jimp.read(path)))
    .then(([aImage, bImage]) => {
      const diff = jimp.diff(aImage, bImage);
      return diff.percent < config.diffThreshold;
    });
}

function handleSnapshot() {
  if (fs.existsSync(currentPath)) {
    fs.renameSync(currentPath, lastPath);
  }
  if (fs.existsSync(lastPath)) {
    return saveSnapshot(currentPath).then(() => true);
  }
  return saveSnapshot(lastPath).then(() => false);
}

function getLabels() {
  return new Promise((resolve, reject) => {
    const params = {
      Image: {
        Bytes: fs.readFileSync(currentPath),
      },
    };
    rekognition.detectLabels(params, (err, data) => {
      if (err) {
        return reject(err);
      }
      const confidentLabels = data.Labels
        .filter(label => label.Confidence > config.confidenceThreshold)
        .map(label => label.Name);
      return resolve(confidentLabels);
    });
  });
}

async function handleDetect() {
  const shouldContinue = await handleSnapshot();
  if (!shouldContinue) {
    console.log('should not continue');
    return false;
  }
  const similar = await snapshotsSimilar();
  if (similar) {
    console.log('similar');
    return false;
  }
  const labels = await getLabels();
  console.log(labels);
  // TODO: Send base64 image and labels to email
  // We have detected "<labels>" from the "<cameraName>" camera.
}

function loop() {
  handleDetect();
  setTimeout(loop, config.intervalTime);
}

loop();
