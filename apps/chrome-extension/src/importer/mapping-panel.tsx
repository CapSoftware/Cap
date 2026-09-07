import { SlidersHorizontalIcon } from "lucide-react";
import type { ColumnMapping, InventoryOptions } from "./inventory";

const ColumnSelect = ({
	headers,
	value,
	onChange,
	label,
}: {
	headers: string[];
	value: number;
	onChange: (value: number) => void;
	label: string;
}) => (
	<label className="field">
		<span>{label}</span>
		<select
			value={value}
			onChange={(event) => onChange(Number(event.target.value))}
		>
			<option value={-1}>Not mapped</option>
			{headers.map((header, index) => (
				<option key={header} value={index}>
					{header}
				</option>
			))}
		</select>
	</label>
);

export const MappingPanel = ({
	headers,
	mapping,
	options,
	disabled,
	onChange,
}: {
	headers: string[];
	mapping: ColumnMapping;
	options: InventoryOptions;
	disabled: boolean;
	onChange: (mapping: ColumnMapping, options: InventoryOptions) => void;
}) => (
	<details className="mapping-panel" open>
		<summary>
			<SlidersHorizontalIcon size={16} aria-hidden />
			Review your mapping
			<span>Choose where each video belongs</span>
		</summary>
		<fieldset disabled={disabled} className="mapping-fields">
			<ColumnSelect
				headers={headers}
				value={mapping.url}
				label="Loom video link"
				onChange={(url) => onChange({ ...mapping, url }, options)}
			/>
			<div className="field-stack">
				<label className="field">
					<span>Cap video owner</span>
					<select
						value={options.ownerMode}
						onChange={(event) =>
							onChange(mapping, {
								...options,
								ownerMode:
									event.target.value === "column" ? "column" : "override",
							})
						}
					>
						<option value="column">Use an email column</option>
						<option value="override">Assign everyone to one owner</option>
					</select>
				</label>
				{options.ownerMode === "column" ? (
					<ColumnSelect
						headers={headers}
						value={mapping.owner}
						label="Owner email column"
						onChange={(owner) => onChange({ ...mapping, owner }, options)}
					/>
				) : (
					<label className="field">
						<span>Owner email</span>
						<input
							type="email"
							maxLength={254}
							placeholder="you@company.com"
							value={options.ownerEmail}
							onChange={(event) =>
								onChange(mapping, {
									...options,
									ownerEmail: event.target.value,
								})
							}
						/>
					</label>
				)}
			</div>
			<div className="field-stack">
				<label className="field">
					<span>Destination Space</span>
					<select
						value={options.spaceMode}
						onChange={(event) => {
							const value = event.target.value;
							onChange(mapping, {
								...options,
								spaceMode:
									value === "column" || value === "override" ? value : "none",
							});
						}}
					>
						<option value="none">No Space · owner’s library</option>
						<option value="override">One Space for all videos</option>
						<option value="column">Use a Space column</option>
					</select>
				</label>
				{options.spaceMode === "column" ? (
					<ColumnSelect
						headers={headers}
						value={mapping.space}
						label="Space column"
						onChange={(space) => onChange({ ...mapping, space }, options)}
					/>
				) : options.spaceMode === "override" ? (
					<label className="field">
						<span>Space name</span>
						<input
							type="text"
							maxLength={255}
							placeholder="e.g. Team knowledge"
							value={options.spaceName}
							onChange={(event) =>
								onChange(mapping, { ...options, spaceName: event.target.value })
							}
						/>
					</label>
				) : (
					<p className="field-hint">
						Loom folders aren’t mapped automatically.
					</p>
				)}
			</div>
			<ColumnSelect
				headers={headers}
				value={mapping.title}
				label="Video title (preview only)"
				onChange={(title) => onChange({ ...mapping, title }, options)}
			/>
		</fieldset>
		<p className="mapping-note">
			{disabled
				? "Mapping is locked after imports start. Clear this inventory to prepare a different mapping."
				: "Named Spaces are reused or created as flat Spaces. Loom folders and sharing permissions are not copied."}
		</p>
	</details>
);
