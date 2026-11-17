"use client";

import type { SettingField, SettingValue } from "@cap/app-store";
import { Select, Switch } from "@cap/ui";
import clsx from "clsx";

export type SettingsDraft = Record<string, SettingValue>;

export function initialDraft(
	fields: readonly SettingField[],
	values: Record<string, SettingValue> = {},
): SettingsDraft {
	const draft: SettingsDraft = {};
	for (const field of fields) {
		const value = values[field.key];
		if (field.type === "toggle") {
			draft[field.key] =
				typeof value === "boolean" ? value : (field.default ?? false);
		} else if (field.type === "secret") {
			draft[field.key] = "";
		} else {
			draft[field.key] =
				typeof value === "string" ? value : (field.default ?? "");
		}
	}
	return draft;
}

const inputClass =
	"h-9 w-full rounded-lg border border-gray-4 bg-gray-1 px-3 text-[13px] text-gray-12 outline-none transition-colors placeholder:text-gray-8 hover:border-gray-5 focus:border-gray-7 disabled:opacity-60";

export function SettingsForm({
	fields,
	draft,
	onChange,
	errors,
	secretsSet = [],
	disabled,
	idPrefix,
}: {
	fields: readonly SettingField[];
	draft: SettingsDraft;
	onChange: (draft: SettingsDraft) => void;
	errors?: Record<string, string>;
	secretsSet?: readonly string[];
	disabled?: boolean;
	idPrefix: string;
}) {
	const set = (key: string, value: SettingValue) =>
		onChange({ ...draft, [key]: value });

	return (
		<div className="flex flex-col gap-4">
			{fields.map((field) => {
				const id = `${idPrefix}-${field.key}`;
				const error = errors?.[field.key];
				const description = field.description ? (
					<p
						id={`${id}-description`}
						className="text-[11px] leading-relaxed text-gray-9"
					>
						{field.description}
					</p>
				) : null;

				if (field.type === "toggle") {
					return (
						<div
							key={field.key}
							className="flex items-start justify-between gap-4"
						>
							<div className="min-w-0">
								<label
									htmlFor={id}
									className="text-[12px] font-medium text-gray-12"
								>
									{field.label}
								</label>
								{description}
							</div>
							<Switch
								id={id}
								checked={draft[field.key] === true}
								disabled={disabled}
								onCheckedChange={(checked) => set(field.key, checked)}
								aria-describedby={
									field.description ? `${id}-description` : undefined
								}
							/>
						</div>
					);
				}

				const required = "required" in field && field.required;
				return (
					<div key={field.key} className="flex flex-col gap-1.5">
						<label
							htmlFor={id}
							className="text-[12px] font-medium text-gray-12"
						>
							{field.label}
							{required ? null : (
								<span className="ml-1 font-normal text-gray-9">Optional</span>
							)}
						</label>
						{field.type === "select" ? (
							<Select
								value={String(draft[field.key] ?? "")}
								onValueChange={(value) => set(field.key, value)}
								options={field.options.map((option) => ({
									value: option.value,
									label: option.label,
								}))}
								placeholder="Choose"
								disabled={disabled}
							/>
						) : (
							<input
								id={id}
								type={
									field.type === "secret"
										? "password"
										: field.type === "url"
											? "url"
											: "text"
								}
								autoComplete="off"
								spellCheck={false}
								value={String(draft[field.key] ?? "")}
								disabled={disabled}
								onChange={(event) => set(field.key, event.target.value)}
								placeholder={
									field.type === "secret" && secretsSet.includes(field.key)
										? "Saved. Enter a new value to replace it"
										: "placeholder" in field
											? field.placeholder
											: undefined
								}
								aria-invalid={error ? true : undefined}
								aria-describedby={
									field.description ? `${id}-description` : undefined
								}
								className={clsx(inputClass, error && "border-red-500")}
							/>
						)}
						{description}
						{error && <p className="text-[11px] text-red-500">{error}</p>}
					</div>
				);
			})}
		</div>
	);
}
