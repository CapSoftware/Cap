on run argv
	set capTarget to item 1 of argv
	set waitSeconds to (item 2 of argv) as integer
	set startTitles to items 3 thru -1 of argv
	tell application "System Events"
		repeat (waitSeconds * 4) times
			try
				if capTarget starts with "pid:" then
					set capProcess to first process whose unix id is ((text 5 thru -1 of capTarget) as integer)
				else
					set capProcess to first process whose bundle identifier is capTarget
				end if
				repeat with candidate in windows of capProcess
					set dialogs to {}
					if subrole of candidate is "AXDialog" then set end of dialogs to candidate
					repeat with attached in sheets of candidate
						set end of dialogs to attached
					end repeat
					repeat with dialog in dialogs
						repeat with dialogButton in buttons of dialog
							if startTitles contains (name of dialogButton) then
								click dialogButton
								return "confirmed"
							end if
						end repeat
					end repeat
				end repeat
			on error errorMessage number errorNumber
				if errorNumber is in {-1719, -1743, -25211} then
					return "permission: " & errorMessage & " Allow the terminal under System Settings > Privacy & Security > Accessibility."
				end if
			end try
			delay 0.25
		end repeat
	end tell
	return "no confirmation shown"
end run
