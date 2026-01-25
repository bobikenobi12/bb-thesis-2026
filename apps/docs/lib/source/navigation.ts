export function getSection(path: string | undefined) {
	if (!path) return "grape";
	const [dir] = path.split("/", 1);
	if (!dir) return "grape";
	return (
		{
			grape: "grape",
			trellis: "trellis",
			tendril: "tendril",
		}[dir] ?? "grape"
	);
}