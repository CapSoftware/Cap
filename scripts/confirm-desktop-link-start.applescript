on run argv
	set capTarget to item 1 of argv
	set waitSeconds to (item 2 of argv) as integer
	tell application "System Events"
		repeat (waitSeconds * 4) times
			try
				if capTarget starts with "pid:" then
					set capProcess to first process whose unix id is ((text 5 thru -1 of capTarget) as integer)
				else
					set capProcess to first process whose bundle identifier is capTarget
				end if
				repeat with candidate in windows of capProcess
					set dialog to missing value
					if subrole of candidate is "AXDialog" then
						set dialog to candidate
					else if (count of sheets of candidate) > 0 then
						set dialog to sheet 1 of candidate
					end if
					if dialog is not missing value then
						click (value of attribute "AXDefaultButton" of dialog)
						return "confirmed"
					end if
				end repeat
			end try
			delay 0.25
		end repeat
	end tell
	return "no confirmation shown"
end run
