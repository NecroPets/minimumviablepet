import Vision
import AppKit
import CoreImage
import ImageIO
import UniformTypeIdentifiers

let inPath = CommandLine.arguments[1]
let outPath = CommandLine.arguments[2]

guard let img = NSImage(contentsOfFile: inPath),
      let tiff = img.tiffRepresentation,
      let bmp = NSBitmapImageRep(data: tiff),
      let cg = bmp.cgImage else { FileHandle.standardError.write("load_failed\n".data(using: .utf8)!); exit(2) }

let req = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([req])
guard let result = req.results?.first else { FileHandle.standardError.write("no_foreground\n".data(using: .utf8)!); exit(3) }

let masked = try result.generateMaskedImage(ofInstances: result.allInstances, from: handler, croppedToInstancesExtent: true)
let ci = CIImage(cvPixelBuffer: masked)
let ctx = CIContext()
guard let out = ctx.createCGImage(ci, from: ci.extent) else { FileHandle.standardError.write("render_failed\n".data(using: .utf8)!); exit(4) }

guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outPath) as CFURL, UTType.png.identifier as CFString, 1, nil) else { FileHandle.standardError.write("dest_failed\n".data(using: .utf8)!); exit(5) }
CGImageDestinationAddImage(dest, out, nil)
CGImageDestinationFinalize(dest)
print("ok \(out.width)x\(out.height)")
