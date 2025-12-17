import twilio from 'twilio';
import { config } from './src/config';

async function runReminderTest() {
  const fromNumber = config.twilio.whatsappFrom;
  const toNumber = '+972543644512'; // TODO: replace with your test/sandbox number
  const templateSid = config.templates.mainMenu;

  const client = twilio(config.twilio.accountSid, config.twilio.authToken);

  console.log('='.repeat(60));
  console.log('REMINDER TEST: 30 seconds delay');
  console.log('='.repeat(60));
  console.log(`From: whatsapp:${fromNumber}`);
  console.log(`To:   whatsapp:${toNumber}`);
  console.log(`Template SID (mainMenu): ${templateSid}`);
  console.log('');
  console.log('⏳ Waiting 30 seconds before sending reminder message...');
  console.log('');

  await new Promise((resolve) => setTimeout(resolve, 30_000));

  try {
    console.log('📤 Sending reminder (mainMenu template)...');
    const result = await client.messages.create({
      from: `whatsapp:${fromNumber}`,
      to: `whatsapp:${toNumber}`,
      contentSid: templateSid,
    });

    console.log('✅ Reminder message created!');
    console.log(`Message SID: ${result.sid}`);
    console.log(`Status:      ${result.status}`);
    console.log('');
    console.log('Check your WhatsApp – you should see the main menu template now.');
  } catch (error: any) {
    console.error('\n❌ Error sending reminder test message:');
    console.error(`Error Code: ${error.code}`);
    console.error(`Error Message: ${error.message}`);
    console.error('\nFull error:', error);
    process.exit(1);
  }
}

runReminderTest();


