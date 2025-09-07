import path from 'path'

const root_path = process.cwd()

export default {
  PORT: 8088,
  PATH: {
    ROOT: root_path,
    SRC: path.join(root_path, 'src'),
    STATIC: path.join(root_path, 'static'),
  }
}