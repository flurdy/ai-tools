export function encodeRow(fields) {
	return fields.map((field) => {
		if (/[,"\r\n]/.test(field) || (fields.length === 1 && field === "")) {
			return `"${field}"`;
		}
		return field;
	}).join(",") + "\r\n";
}
