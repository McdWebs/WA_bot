import twilio from 'twilio';
import { config } from './src/config';

/**
 * Test script to fetch template details from Twilio Content API
 * This will show the actual language/locale code for the template
 */
async function checkTemplateDetails() {
  // Check both mainMenu and genderQuestion to compare
  const mainMenuSid = config.templates.mainMenu;
  const genderQuestionSid = config.templates.genderQuestion;
  
  console.log('Checking MAIN MENU template:');
  console.log('='.repeat(60));
  await checkSingleTemplate(mainMenuSid, 'mainMenu');
  
  if (genderQuestionSid) {
    console.log('\n\nChecking GENDER QUESTION template (for comparison):');
    console.log('='.repeat(60));
    await checkSingleTemplate(genderQuestionSid, 'genderQuestion');
  }
}

async function checkSingleTemplate(templateSid: string, templateName: string) {
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);

  if (!templateSid) {
    console.error(`❌ ${templateName} Template SID not configured`);
    return;
  }

  try {
    console.log('='.repeat(60));
    console.log('CHECKING TEMPLATE DETAILS');
    console.log('='.repeat(60));
    console.log(`Template SID: ${templateSid}`);
    console.log('');

    // Fetch template details from Content API
    const content: any = await client.content.v1.contents(templateSid).fetch();

    console.log('📋 Template Details:');
    console.log(`   Name: ${content.friendlyName || 'N/A'}`);
    console.log(`   Language: ${content.language || 'N/A'}`);
    console.log(`   Types: ${JSON.stringify(content.types)}`);
    if (content.approvalRequests) {
      console.log(`   Approval Requests: ${JSON.stringify(content.approvalRequests, null, 2)}`);
    }
    console.log('');

    // Check WhatsApp approval status
    if (content.approvalRequests) {
      const whatsappApproval = content.approvalRequests.find(
        (req: any) => req.name === 'whatsapp'
      );
      if (whatsappApproval) {
        console.log('📱 WhatsApp Approval Status:');
        console.log(`   Status: ${whatsappApproval.status}`);
        console.log(`   Date Updated: ${whatsappApproval.dateUpdated}`);
        if (whatsappApproval.allowedCategories) {
          console.log(`   Allowed Categories: ${whatsappApproval.allowedCategories.join(', ')}`);
        }
        console.log('');
      }
    }

    console.log('📱 WhatsApp Approval:');
    console.log('   Check the Twilio Console for approval status');
    console.log('   Approval link:', content.links?.approval_fetch || 'N/A');
    console.log('');

    // Full content object for debugging
    console.log('🔍 Full Template Object:');
    console.log(JSON.stringify(content, null, 2));

  } catch (error: any) {
    console.error('\n❌ Error fetching template details:');
    console.error(`Error Code: ${error.code}`);
    console.error(`Error Message: ${error.message}`);
    if (error.moreInfo) {
      console.error(`More Info: ${error.moreInfo}`);
    }
    console.error('\nFull error:', error);
    process.exit(1);
  }
}

// Run the check
checkTemplateDetails();

