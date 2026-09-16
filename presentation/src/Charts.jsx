import React, { useMemo } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Legend, Cell
} from 'recharts'

const CAT = [
  '#4e79a7',
  '#f28e2b',
  '#e15759',
  '#76b7b2',
  '#59a14f',
  '#edc948',
]
const DARK = '#1c1028'
const MUTED = '#80708f'
const BORDER = '#dbd6e1'

const ax = {
  axisLine: { stroke: BORDER },
  tickLine: false,
  tick: { fill: MUTED, fontSize: 11, fontFamily: 'Rubik, system-ui' }
}
const grid = { strokeDasharray: '3 3', stroke: '#f0edf3', vertical: false }
const tip = {
  contentStyle: {
    background: '#fff',
    border: `1px solid ${BORDER}`,
    borderRadius: 6,
    fontSize: 12,
    fontFamily: 'Rubik, system-ui'
  }
}

export function TilePyramidChart() {
  const data = useMemo(() => ([
    { nivel: 'Z0', demo2048: 1, demo4096: 1 },
    { nivel: 'Z1', demo2048: 4, demo4096: 4 },
    { nivel: 'Z2', demo2048: 16, demo4096: 16 },
    { nivel: 'Z3', demo2048: 0, demo4096: 64 },
  ]), [])
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
        <CartesianGrid {...grid} />
        <XAxis dataKey="nivel" {...ax} />
        <YAxis {...ax} allowDecimals={false} />
        <Tooltip {...tip} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="demo2048" name="Demo 0, 2048 px, 21 tiles" fill={CAT[0]} radius={[3, 3, 0, 0]} />
        <Bar dataKey="demo4096" name="Demo 1, 4096 px, 85 tiles" fill={CAT[1]} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function MemoryEnvelopeChart() {
  const data = useMemo(() => ([
    { bloque: 'Cache 40 tiles', mib: 40 },
    { bloque: 'En vuelo 6 x 2 MiB', mib: 12 },
    { bloque: 'Cola 4 MiB', mib: 4 },
    { bloque: 'Transitorio max.', mib: 60 },
  ]), [])
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
        <CartesianGrid {...grid} />
        <XAxis dataKey="bloque" {...ax} interval={0} tick={{ fill: MUTED, fontSize: 10, fontFamily: 'Rubik, system-ui' }} />
        <YAxis {...ax} label={{ value: 'MiB', angle: -90, position: 'insideLeft', fill: MUTED, fontSize: 11 }} />
        <Tooltip {...tip} formatter={(v) => [`${v} MiB`, 'Memoria']} />
        <Bar dataKey="mib" name="MiB" radius={[3, 3, 0, 0]}>
          <Cell fill={CAT[0]} />
          <Cell fill={CAT[3]} />
          <Cell fill={CAT[5]} />
          <Cell fill={CAT[2]} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export { DARK }
