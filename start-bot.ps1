# C:\whatsapp-bot\start-bot.ps1

# Change to the bot directory
Set-Location -Path "C:\whatsapp-bot"

# Ensure HEADLESS is true for this session
$env:HEADLESS = "false"

# Launch the bot and redirect stdout+stderr to bot.log
node bot.js >> bot.log 2>&1
