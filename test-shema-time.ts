import hebcalService from "./src/services/hebcal";
import axios from "axios";

/**
 * Test script to check Shema time retrieval from Hebcal API
 * This will show:
 * 1. What fields are available in the Zmanim API response
 * 2. Whether the Shema time is found correctly
 * 3. The calculated/retrieved Shema time
 */
async function testShemaTime() {
  console.log("=".repeat(60));
  console.log("SHEMA TIME TEST");
  console.log("=".repeat(60));
  console.log("");

  const testLocations = ["Jerusalem", "Tel Aviv", "Haifa", "Beer Sheva"];
  const testDate = undefined; // Use today

  for (const location of testLocations) {
    console.log(`\n📍 Testing location: ${location}`);
    console.log("-".repeat(60));

    try {
      // First, get the Hebcal data to get coordinates
      const hebcalData = await hebcalService.getHebcalData(location, testDate);
      const latitude = hebcalData.location?.latitude || 31.7683;
      const longitude = hebcalData.location?.longitude || 35.2137;

      console.log(`Coordinates: lat=${latitude}, lon=${longitude}`);

      // Get Zmanim data directly from API to see all available fields
      console.log("\n📡 Fetching Zmanim data directly from API...");
      const zmanimResponse = await axios.get("https://www.hebcal.com/zmanim", {
        params: {
          cfg: "json",
          latitude: latitude.toString(),
          longitude: longitude.toString(),
        },
      });

      if (zmanimResponse.data?.times) {
        console.log("\n📋 Available Zmanim fields:");
        const fields = Object.keys(zmanimResponse.data.times);
        fields.forEach((field) => {
          const time = zmanimResponse.data.times[field];
          console.log(`   - ${field}: ${time}`);
        });

        // Check for Shema-related fields (camelCase: sofZmanShma, etc.)
        console.log("\n🔍 Checking for Shema-related fields:");
        const shemaFields = fields.filter(
          (f) =>
            f.toLowerCase().includes("shema") ||
            f.toLowerCase().includes("shma") ||
            f.toLowerCase().includes("kriat")
        );
        if (shemaFields.length > 0) {
          console.log(
            `   ✅ Found ${shemaFields.length} Shema-related field(s):`
          );
          shemaFields.forEach((field) => {
            const time = zmanimResponse.data.times[field];
            // Extract time from ISO format
            const timeMatch = time.match(/T(\d{2}):(\d{2}):\d{2}/);
            const displayTime = timeMatch
              ? `${timeMatch[1]}:${timeMatch[2]}`
              : time;
            console.log(`      - ${field}: ${displayTime}`);
          });
        } else {
          console.log("   ⚠️  No Shema-specific fields found");
          console.log(
            "   (This is why the function might be calculating from sunrise)"
          );
        }
      } else {
        console.log("❌ No Zmanim data available");
      }

      // Now test the getShemaTime function
      console.log("\n⏰ Testing getShemaTime() function:");
      const shemaTime = await hebcalService.getShemaTime(location, testDate);

      if (shemaTime) {
        console.log(`   ✅ Shema time retrieved: ${shemaTime}`);
      } else {
        console.log("   ❌ Failed to retrieve Shema time");
      }
    } catch (error: any) {
      console.error(`\n❌ Error testing ${location}:`);
      console.error(`   Error: ${error.message}`);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Data: ${JSON.stringify(error.response.data)}`);
      }
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("TEST COMPLETE");
  console.log("=".repeat(60));
  console.log("\n💡 Check the logs above to see:");
  console.log("   1. What fields the Zmanim API actually returns");
  console.log("   2. Whether Shema-specific fields exist");
  console.log("   3. The final Shema time that was retrieved/calculated");
}

// Run the test
testShemaTime().catch((error) => {
  console.error("\n❌ Fatal error:", error);
  process.exit(1);
});
