const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3001;
const MAX_RECIPIENTS = 100;
const EMAIL_DELAY_MS = 5000;

let campaignRunning = false;

/* ------------------------- Middleware ------------------------- */

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'x-admin-key'],
  })
);

app.use(express.json({ limit: '2mb' }));

/* ------------------------- MongoDB model ------------------------- */

const emailSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    subscribed: {
      type: Boolean,
      default: true,
    },
    unsubscribeToken: {
      type: String,
      unique: true,
      sparse: true,
    },
  },
  {
    timestamps: true,
  }
);

const Email = mongoose.model('Email', emailSchema);

/* ------------------------- Helper functions ------------------------- */

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const isValidEmail = (email) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const normalizeRecipients = (recipients) => {
  if (!Array.isArray(recipients)) {
    return [];
  }

  return [
    ...new Set(
      recipients
        .filter((email) => typeof email === 'string')
        .map((email) => email.trim().toLowerCase())
        .filter(isValidEmail)
    ),
  ];
};

const escapeHtml = (value = '') => {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
};

// Converts HTML entered in the editor into plain text.
const htmlToPlainText = (value = '') => {
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const getPublicApiUrl = () => {
  return (process.env.PUBLIC_API_URL || `http://localhost:${PORT}`).replace(
    /\/$/,
    ''
  );
};

/* ------------------------- Admin protection ------------------------- */

const requireAdminKey = (req, res, next) => {
  if (!process.env.ADMIN_KEY) {
    return res.status(500).json({
      success: false,
      message: 'ADMIN_KEY is missing from the server environment.',
    });
  }

  const suppliedKey = req.get('x-admin-key');

  if (!suppliedKey || suppliedKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized.',
    });
  }

  next();
};

/* ------------------------- Gmail transporter ------------------------- */

const createTransporter = async () => {
  const requiredVariables = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN',
    'GOOGLE_USER_EMAIL',
  ];

  const missingVariables = requiredVariables.filter(
    (variableName) => !process.env[variableName]
  );

  if (missingVariables.length > 0) {
    throw new Error(
      `Missing environment variables: ${missingVariables.join(', ')}`
    );
  }

  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oAuth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  const accessTokenResult = await oAuth2Client.getAccessToken();

  const accessToken =
    typeof accessTokenResult === 'string'
      ? accessTokenResult
      : accessTokenResult?.token;

  if (!accessToken) {
    throw new Error('Google did not return an OAuth access token.');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: process.env.GOOGLE_USER_EMAIL,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      accessToken,
    },
  });

  await transporter.verify();

  return transporter;
};

/* ------------------------- Email records ------------------------- */

const getOrCreateEmailRecord = async (emailAddress) => {
  let emailRecord = await Email.findOne({
    email: emailAddress,
  });

  // Never send again to an unsubscribed address.
  if (emailRecord && !emailRecord.subscribed) {
    return null;
  }

  if (!emailRecord) {
    emailRecord = await Email.create({
      email: emailAddress,
      subscribed: true,
      unsubscribeToken: crypto.randomBytes(32).toString('hex'),
    });

    return emailRecord;
  }

  if (!emailRecord.unsubscribeToken) {
    emailRecord.unsubscribeToken = crypto.randomBytes(32).toString('hex');
    await emailRecord.save();
  }

  return emailRecord;
};

/* ------------------------- Campaign sending ------------------------- */

const sendCampaign = async ({ recipients, subject, emailBody }) => {
  const transporter = await createTransporter();

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (let index = 0; index < recipients.length; index += 1) {
    const recipient = recipients[index];

    try {
      const emailRecord = await getOrCreateEmailRecord(recipient);

      if (!emailRecord) {
        skipped += 1;
        console.log(`Skipped unsubscribed recipient: ${recipient}`);
        continue;
      }

      const unsubscribeUrl =
        `${getPublicApiUrl()}/unsubscribe/` +
        encodeURIComponent(emailRecord.unsubscribeToken);

      const messageText = htmlToPlainText(emailBody);

      const completeEmailBody = [
        messageText,
        '',
        '--',
        '3D Spot',
        `Unsubscribe: ${unsubscribeUrl}`,
      ].join('\n');

      await transporter.sendMail({
        from: `"Aarya from 3D Spot" <${process.env.GOOGLE_USER_EMAIL}>`,
        replyTo:
          process.env.REPLY_TO_EMAIL || process.env.GOOGLE_USER_EMAIL,
        to: recipient,
        subject,
        text: completeEmailBody,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });

      sent += 1;
      console.log(`Email sent to ${recipient}`);
    } catch (error) {
      failed += 1;
      console.error(`Failed to send to ${recipient}:`, error.message);
    }

    if (index < recipients.length - 1) {
      await sleep(EMAIL_DELAY_MS);
    }
  }

  return {
    total: recipients.length,
    sent,
    failed,
    skipped,
  };
};

/* ------------------------- General routes ------------------------- */

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '3D Spot Email Sender API is running.',
    campaignRunning,
  });
});

app.get('/campaign-status', requireAdminKey, (req, res) => {
  res.json({
    success: true,
    campaignRunning,
  });
});

/* ------------------------- Start campaign ------------------------- */

app.post('/start-email-campaign', requireAdminKey, async (req, res) => {
  try {
    if (campaignRunning) {
      return res.status(409).json({
        success: false,
        message: 'Another email campaign is currently running.',
      });
    }

    const {
      recipients,
      subject,
      emailBody,
      consentConfirmed,
    } = req.body;

    if (consentConfirmed !== true) {
      return res.status(400).json({
        success: false,
        message:
          'Please confirm that the recipients agreed to receive emails.',
      });
    }

    const normalizedRecipients = normalizeRecipients(recipients);

    if (normalizedRecipients.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Enter at least one valid email address.',
      });
    }

    if (normalizedRecipients.length > MAX_RECIPIENTS) {
      return res.status(400).json({
        success: false,
        message: `A maximum of ${MAX_RECIPIENTS} recipients is allowed per campaign.`,
      });
    }

    if (typeof subject !== 'string' || !subject.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Email subject is required.',
      });
    }

    if (typeof emailBody !== 'string' || !emailBody.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Email content is required.',
      });
    }

    const unsubscribedRecords = await Email.find({
      email: {
        $in: normalizedRecipients,
      },
      subscribed: false,
    }).select('email');

    const unsubscribedEmails = new Set(
      unsubscribedRecords.map((record) => record.email)
    );

    const allowedRecipients = normalizedRecipients.filter(
      (email) => !unsubscribedEmails.has(email)
    );

    const initiallySkipped =
      normalizedRecipients.length - allowedRecipients.length;

    if (allowedRecipients.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'All supplied recipients previously unsubscribed.',
        skipped: initiallySkipped,
      });
    }

    campaignRunning = true;

    res.status(202).json({
      success: true,
      message: 'Email campaign started.',
      total: normalizedRecipients.length,
      queued: allowedRecipients.length,
      skipped: initiallySkipped,
    });

    sendCampaign({
      recipients: allowedRecipients,
      subject: subject.trim(),
      emailBody,
    })
      .then((result) => {
        result.skipped += initiallySkipped;
        console.log('Campaign completed:', result);
      })
      .catch((error) => {
        console.error('Campaign failed:', error);
      })
      .finally(() => {
        campaignRunning = false;
      });
  } catch (error) {
    campaignRunning = false;

    console.error('Campaign start error:', error);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Unable to start the email campaign.',
      });
    }
  }
});

/* ------------------------- List emails ------------------------- */

app.get('/emails', requireAdminKey, async (req, res) => {
  try {
    const emails = await Email.find()
      .select('email subscribed createdAt updatedAt')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      emails,
    });
  } catch (error) {
    console.error('Fetch emails error:', error);

    res.status(500).json({
      success: false,
      message: 'Unable to fetch email records.',
    });
  }
});

/* ------------------------- Unsubscribe ------------------------- */

const unsubscribeRecipient = async (req, res) => {
  try {
    const emailRecord = await Email.findOneAndUpdate(
      {
        unsubscribeToken: req.params.token,
      },
      {
        subscribed: false,
      },
      {
        new: true,
      }
    );

    if (!emailRecord) {
      return res.status(404).send(`
        <h2>Invalid unsubscribe link</h2>
        <p>This link is invalid or has expired.</p>
      `);
    }

    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1"
          />
          <title>Unsubscribed</title>
        </head>

        <body
          style="
            font-family: Arial, sans-serif;
            padding: 40px;
            text-align: center;
            color: #222222;
          "
        >
          <h2>You have been unsubscribed</h2>

          <p>
            ${escapeHtml(emailRecord.email)} will no longer receive these
            emails.
          </p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Unsubscribe error:', error);

    return res.status(500).send(`
      <h2>Unable to unsubscribe</h2>
      <p>Please try again later.</p>
    `);
  }
};

app.get('/unsubscribe/:token', unsubscribeRecipient);
app.post('/unsubscribe/:token', unsubscribeRecipient);

/* ------------------------- Start server ------------------------- */

const startServer = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI is missing from the .env file.');
    }

    await mongoose.connect(process.env.MONGO_URI);

    console.log('MongoDB connected');

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Server startup failed:', error.message);
    process.exit(1);
  }
};

startServer();