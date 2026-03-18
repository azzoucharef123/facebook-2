const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const PAGE_ACCESS_TOKEN = "EAATTbmxCOKkBQ9Y6QWzpp112drGI24KvqRca5i61GhbUWyBefuLYnOIjgEnUskODfr6AZAI7oujIa6M1BSdYTv44SEmZAdg6eaLZA9vHH25GZCqkAmsEpHnANawFbclPl50xMi5tKJjNjIHz9xfJlFKTHsXz9Qs92mHubXvbyBdntx36dQqZC2o9xykETQ0faz6ZBjmIXJfwOyz4sYunvSRGHE"
// التحقق من webhook
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = "c4c16881d180fc06fe46338c4691f0b242f0b42b5c5518e6";

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// استقبال الرسائل
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      for (const event of entry.messaging) {
        const senderId = event.sender.id;

        if (event.message && event.message.text) {
          await axios.post(
            `https://graph.facebook.com/v18.0/me/messages?access_token=${EAATTbmxCOKkBQ9Y6QWzpp112drGI24KvqRca5i61GhbUWyBefuLYnOIjgEnUskODfr6AZAI7oujIa6M1BSdYTv44SEmZAdg6eaLZA9vHH25GZCqkAmsEpHnANawFbclPl50xMi5tKJjNjIHz9xfJlFKTHsXz9Qs92mHubXvbyBdntx36dQqZC2o9xykETQ0faz6ZBjmIXJfwOyz4sYunvSRGHE}`,
            {
              recipient: { id: senderId },
              message: { text: "تم استلام رسالتك 👍" }
            }
          );
        }
      }
    }

    return res.sendStatus(200);
  }

  res.sendStatus(404);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));