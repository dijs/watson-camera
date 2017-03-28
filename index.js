require('dotenv').config();
const fs = require('fs-extra');
const jimp = require('jimp');
const nodemailer = require('nodemailer');
const debug = require('debug');
const Rekognition = require('aws-sdk/clients/Rekognition');

const config = {
  recipientEmails: process.env.RECIPIENT_EMAILS.split(','),
  cameraName: process.env.CAMERA_NAME.trim(),
  senderUser: process.env.SENDER_USER.trim(),
  senderPassword: process.env.SENDER_PASSWORD.trim(),
  snapshotUrl: process.env.SNAPSHOT_URL.trim(),
  diffThreshold: process.env.THRESHOLD ? parseFloat(process.env.THRESHOLD, 10) : 0.05,
  confidenceThreshold: process.env.CONFIDENCE_THRESHOLD ? parseFloat(process.env.CONFIDENCE_THRESHOLD, 10) : 80,
};

const debugLog = debug(`WatsonCameraDebug:${config.cameraName}:`);
const log = debug(`WatsonCamera:${config.cameraName}:`);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: config.senderUser,
    pass: config.senderPassword,
  },
});

let lastImage = null;
let currentImage = null;
let lastDetectionAt = 0;

const rekognition = new Rekognition({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

function getMessage(labels) {
  if (labels.length === 0) {
    return `Detected something on "${config.cameraName}"`;
  }
  return `We have detected "${labels.join(', ')}" from the "${config.cameraName}" camera.`;
}

function sendDetection(labels, detectedImagePath) {
  const message = getMessage(labels);
  const mailOptions = {
    from: '"Watson" <watson.dijs@gmail.com>',
    to: config.recipientEmails,
    subject: message,
    text: message,
    html: `
      <p>${message}</p>
      <br />
      <img src="cid:detection" />
    `,
    attachments: [{
      filename: `detection-${Date.now()}.jpg`,
      path: detectedImagePath,
      cid: 'detection',
    }],
  };
  return new Promise((resolve, reject) => {
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
          return reject(error);
      }
      return resolve(info.messageId);
    });
  });
}

function snapshotsSimilar() {
  const diff = jimp.diff(currentImage, lastImage);
  return diff.percent < config.diffThreshold;
}

function handleSnapshot() {
  if (currentImage) {
    lastImage = currentImage;
  }
  if (lastImage) {
    return jimp.read(config.snapshotUrl)
      .then(image => {
        currentImage = image;
        return true;
      });
  }
  return jimp.read(config.snapshotUrl)
    .then(image => {
      lastImage = image;
      return false;
    });
}

function getLabels(imagePath) {
  return new Promise((resolve, reject) => {
    const params = {
      Image: {
        Bytes: fs.readFileSync(imagePath),
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

function saveDetection() {
  const detectionPath = `./temp/detection-${Date.now()}.jpg`;
  return new Promise((resolve, reject) => {
    currentImage.write(detectionPath, err => {
      if (err) {
        return reject(err);
      }
      return resolve(detectionPath);
    });
  });
}

async function handleDetect() {
  try {
    const shouldContinue = await handleSnapshot();
    if (!shouldContinue) {
      debugLog('Should not continue');
      return false;
    }
    if (Date.now() - lastDetectionAt < 2000) {
      debugLog('Too early after a detection.');
      return;
    }
    const similar = snapshotsSimilar();
    if (similar) {
      debugLog('Current image is similar to last');
      return false;
    }
    log('Detected something. Trying to figure out what it was...');
    lastDetectionAt = Date.now();
    const detectionPath = await saveDetection();
    const labels = await getLabels(detectionPath);
    const messageId = await sendDetection(labels, detectionPath);
    if (labels.length === 0) {
      log('Could not find labels for the detection.');
    } else {
      log(`Detected "${labels.join(', ')}".`);
    }
    fs.remove(detectionPath);
    return true;
  } catch(e) {
    log('Handle Detect Error', e.stack);
  }
  return false;
}

function loop() {
  const started = Date.now();
  handleDetect()
    .then(() => {
      const took = Date.now() - started;
      if (took > 1000) {
        return loop();
      }
      setTimeout(loop, 1000 - took);
    });
}

log('Initializing...');
return jimp.read(config.snapshotUrl)
  .then(image => {
    lastImage = image;
    log('Started watching.');
    loop();
  })
  .catch(e => console.log('could not read image', e))
