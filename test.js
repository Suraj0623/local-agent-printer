const escpos = require("escpos");
escpos.USB = require("escpos-usb");

const device = new escpos.USB(0x0483, 0x5743);
const printer = new escpos.Printer(device);

device.open(() => {
  printer
    .text("TEST PRINT ✅")
    .text("USB DIRECT WORKING")
    .cut()
    .close();
});