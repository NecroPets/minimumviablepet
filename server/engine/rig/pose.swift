import Vision
import AppKit

// Animal facial/body keypoints for a cutout, one per line:
//   <joint>\t<x>\t<y>\t<conf>   with x,y normalized to the image, TOP-LEFT
//   origin (y down) so the caller needs no coordinate flip. Prints nothing
//   but "no_animal_pose" when Vision finds no animal.
let inPath = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: inPath), let tiff = img.tiffRepresentation,
      let bmp = NSBitmapImageRep(data: tiff), let cg = bmp.cgImage else {
  FileHandle.standardError.write("load_failed\n".data(using: .utf8)!); exit(2)
}
let req = VNDetectAnimalBodyPoseRequest()
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([req])
guard let obs = req.results?.first else { print("no_animal_pose"); exit(0) }
let pts = try obs.recognizedPoints(.all)
for (name, p) in pts.sorted(by: { $0.key.rawValue.rawValue < $1.key.rawValue.rawValue }) {
  // Vision is bottom-left origin; flip y to top-left for the renderer
  print(String(format: "%@\t%.4f\t%.4f\t%.2f", name.rawValue.rawValue, p.location.x, 1.0 - p.location.y, p.confidence))
}
