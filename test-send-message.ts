import twilio from 'twilio';
import { config } from './src/config';

/**
 * Simple test script to mirror the new flow:
 * Sends the genderQuestion template to your test number.
 *
 * From there, you use WhatsApp normally:
 * - Tap a gender button → webhook saves gender and sends mainMenu
 * - Tap buttons in mainMenu to continue the flow
 */
async function testSendGenderQuestion() {
  const fromNumber = config.twilio.whatsappFrom;
  const toNumber = '+972543644512'; // TODO: replace with your sandbox test number
  const templateSid = config.templates.genderQuestion;

  const client = twilio(config.twilio.accountSid, config.twilio.authToken);

  try {
    console.log('='.repeat(60));
    console.log('TEST: Send genderQuestion template');
    console.log('='.repeat(60));
    console.log(`From: whatsapp:${fromNumber}`);
    console.log(`To: whatsapp:${toNumber}`);
    console.log(`Template SID: ${templateSid}`);
    console.log('');

    const result = await client.messages.create({
      from: `whatsapp:${fromNumber}`,
      to: `whatsapp:${toNumber}`,
      contentSid: templateSid,
    });

    console.log('✅ genderQuestion template sent!');
    console.log(`Message SID: ${result.sid}`);
    console.log(`Status: ${result.status}`);
    console.log('');

    console.log('Next steps:');
    console.log('1. Open WhatsApp on your phone (sandbox chat).');
    console.log('2. You should see the gender question template.');
    console.log('3. Tap one of the buttons (male / female / prefer_not_to_say).');
    console.log('4. Your webhook will handle it and send the main menu template.');
    console.log('5. Continue by tapping buttons in the main menu.');
  } catch (error: any) {
    console.error('\n❌ Error sending genderQuestion template:');
    console.error(`Error Code: ${error.code}`);
    console.error(`Error Message: ${error.message}`);
    console.error('\nFull error:', error);
    process.exit(1);
  }
}

// Run the test
testSendGenderQuestion();
