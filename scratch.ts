import hebcalService from "./src/services/hebcal";

async function checkShema() {
  try {
    const time = await hebcalService.getShemaTime("Tel Aviv");
    console.log(`Shema time in Tel Aviv: ${time}`);
    const timeJm = await hebcalService.getShemaTime("Jerusalem");
    console.log(`Shema time in Jerusalem: ${timeJm}`);
  } catch (error) {
    console.error(error);
  }
}

checkShema();
